"""
Maison Miro - a deliberately vulnerable demo storefront.

============================================================================
  !!  INTENTIONALLY INSECURE APPLICATION  !!
  This app contains DELIBERATE security vulnerabilities. It exists only as a
  controlled target for a live security demonstration (Comeos keynote).
  DO NOT deploy it on the public internet with real data, and never reuse
  any of this code in a production system. See PRESENTER-NOTES.md.
============================================================================
"""
import base64
import hashlib
import hmac
import json
import os
import re
import random
import sqlite3
import traceback
from collections import deque
from datetime import datetime, timedelta

from flask import (
    Flask,
    Response,
    abort,
    g,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    url_for,
)

app = Flask(__name__)

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "maison_miro.db"))
SESSION_COOKIE = "mm_session"

# --------------------------------------------------------------------------
# Miro-inspired brand palette (used for the generated abstract product art)
# --------------------------------------------------------------------------
BLUE = "#1e50a2"
RED = "#d1402c"
YELLOW = "#f2b705"
GREEN = "#1f7a5a"
INK = "#16130f"
CREAM = "#f4efe1"


# ==========================================================================
# BLUE TEAM / SOC LAYER  (telemetry + detection + containment)
# --------------------------------------------------------------------------
# This is the defensive plane. The store above stays deliberately vulnerable
# so Red can always get IN; this layer makes sure Red cannot get anything
# valuable OUT. It emits structured security events (the "cameras"), exposes
# a small SOC API the Blue agents call, and can slam a containment "shield"
# that leaves ACCESS open but hard-blocks the crown jewels (customer data,
# money, malicious content). A honeytoken guarantees the save even if the
# live agents are slow.
# ==========================================================================
SOC_KEY = os.environ.get("SOC_KEY", "soc-demo-key")
SIGN_SECRET = os.environ.get("SIGN_SECRET", "maison-miro-demo-signing-secret")
EVENTS_LOG = os.environ.get("EVENTS_LOG", os.path.join(os.path.dirname(__file__), "events.log"))
SIG_COOKIE = "mm_sig"

# A decoy "customer" served as page 1 of the bulk export. It looks like a
# normal record, but no legitimate flow ever reads it, so any access to it is
# a certain sign of data theft in progress. Real records live on later pages.
HONEYTOKEN = {
    "id": 1001, "username": "m.lambert", "email": "margaux.lambert@example.com",
    "password": "Brussels#2023", "full_name": "Margaux Lambert",
    "address": "Avenue des Arts 44, 1040 Brussels, BE", "phone": "+32 475 00 11 22",
    "role": "customer",
}


def _new_state():
    return {
        "shield": False,
        "armed": os.environ.get("SOC_ARMED", "1") != "0",  # auto-response on tripwire
        "blocked_ips": set(),
        "blocked_tokens": set(),
        "events": deque(maxlen=1000),
        "seen_forged": set(),
        "seen_recon": set(),
        "scores": {
            "records_exfiltrated": 0,
            "money_lost_cents": 0,
            "customers_affected": 0,
            "signals": 0,
            "attempts_blocked": 0,
        },
        "first_attack_at": None,
        "contained_at": None,
        "contained_by": None,
        "contain_reason": None,
    }


STATE = _new_state()


def reset_all_state():
    STATE.clear()
    STATE.update(_new_state())


def actor_ip():
    xff = request.headers.get("X-Forwarded-For", "")
    return (xff.split(",")[0].strip() if xff else request.remote_addr) or "unknown"


def actor_token():
    return request.cookies.get(SESSION_COOKIE) or ""


def sign_value(v):
    return hmac.new(SIGN_SECRET.encode(), v.encode(), hashlib.sha256).hexdigest()


def soc_authed():
    key = request.headers.get("X-SOC-Key") or request.args.get("key")
    return key == SOC_KEY


def is_blocked(ip, token):
    return ip in STATE["blocked_ips"] or (token and token in STATE["blocked_tokens"])


def defense_on():
    """Detective controls (fraud hold, XSS quarantine) are active."""
    return STATE["armed"] or STATE["shield"]


def _write_log(ev):
    try:
        with open(EVENTS_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev) + "\n")
    except Exception:
        pass
    print("[EVENT]", json.dumps(ev), flush=True)


def emit_event(etype, severity, message, ip=None, token=None, by=None, **extra):
    ip = ip or actor_ip()
    token = token if token is not None else actor_token()
    ev = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "type": etype,
        "severity": severity,
        "message": message,
        "source_ip": ip,
        "session": (token or "")[:16],
        "by": by,
    }
    if extra:
        ev.update(extra)
    STATE["events"].append(ev)
    if severity in ("high", "critical"):
        STATE["scores"]["signals"] += 1
        if STATE["first_attack_at"] is None:
            STATE["first_attack_at"] = ev["ts"]
    _write_log(ev)
    # Armed automated response: a critical, high-impact event trips containment.
    if severity == "critical" and STATE["armed"] and not STATE["shield"]:
        contain(reason="auto-response: " + etype, ip=ip, token=token, by="auto-soar")
    return ev


def contain(reason="containment", ip=None, token=None, by="soc"):
    newly = not STATE["shield"]
    STATE["shield"] = True
    if ip:
        STATE["blocked_ips"].add(ip)
    if token:
        STATE["blocked_tokens"].add(token)
    if STATE["contained_at"] is None:
        STATE["contained_at"] = datetime.now().isoformat(timespec="seconds")
        STATE["contained_by"] = by
        STATE["contain_reason"] = reason
    ev = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "type": "containment.engaged", "severity": "info",
        "message": "Containment engaged (" + reason + ")",
        "source_ip": ip or "", "session": (token or "")[:16], "by": by,
    }
    STATE["events"].append(ev)
    _write_log(ev)
    return newly


def release_containment(reset_scores=False):
    STATE["shield"] = False
    STATE["blocked_ips"].clear()
    STATE["blocked_tokens"].clear()
    STATE["contained_at"] = None
    STATE["contained_by"] = None
    STATE["contain_reason"] = None
    STATE["armed"] = True
    if reset_scores:
        for k in STATE["scores"]:
            STATE["scores"][k] = 0
        STATE["events"].clear()
        STATE["first_attack_at"] = None
        STATE["seen_forged"].clear()
        STATE["seen_recon"].clear()
    emit_event("soc.released", "info", "Containment released; defences re-armed", by="soc")


def _seconds_between(a, b):
    try:
        return round((datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds(), 1)
    except Exception:
        return None


def soc_state_dict():
    s = STATE
    return {
        "shield": s["shield"],
        "armed": s["armed"],
        "contained": s["contained_at"] is not None,
        "blocked_ips": sorted(s["blocked_ips"]),
        "blocked_tokens": [t[:16] for t in s["blocked_tokens"]],
        "scores": dict(s["scores"]),
        "first_attack_at": s["first_attack_at"],
        "contained_at": s["contained_at"],
        "contained_by": s["contained_by"],
        "contain_reason": s["contain_reason"],
        "time_to_contain_s": _seconds_between(s["first_attack_at"], s["contained_at"])
        if (s["first_attack_at"] and s["contained_at"]) else None,
        "total_events": len(s["events"]),
    }


def set_session_cookies(resp, sess):
    # The unsigned session (intentional flaw) is what the app trusts for authz.
    resp.set_cookie(SESSION_COOKIE, sess, httponly=False, samesite="Lax")
    # A parallel HMAC tag the app does NOT use for authz, but the SOC detector
    # checks to spot forged/tampered sessions. Forging one without this tag trips.
    resp.set_cookie(SIG_COOKIE, sign_value(sess), httponly=False, samesite="Lax")
    return resp


SQLI_RE = re.compile(r"('|--|;|/\*|\bunion\b|\bor\b\s+['\"\d])", re.I)
XSS_RE = re.compile(r"(<script|onerror\s*=|onload\s*=|<img|<svg|<iframe|javascript:)", re.I)


def looks_like_sqli(s):
    return bool(s) and bool(SQLI_RE.search(s))


def detect_forged_session(ip, tok):
    if not tok:
        return
    if request.cookies.get(SIG_COOKIE) == sign_value(tok):
        return  # legitimately issued session
    key = tok[:24]
    if key in STATE["seen_forged"]:
        return
    STATE["seen_forged"].add(key)
    role = "?"
    try:
        role = json.loads(base64.urlsafe_b64decode(tok.encode())).get("role", "?")
    except Exception:
        pass
    emit_event("auth.session_forged", "high",
               "Forged/tampered session presented (claims role=" + str(role) + ")",
               ip=ip, token=tok)


def detect_recon(p, ip, tok):
    if p.startswith("/api") or p == "/admin" or p.startswith("/invoice"):
        key = (ip or "") + "|recon"
        if key in STATE["seen_recon"]:
            return
        STATE["seen_recon"].add(key)
        emit_event("recon.disallowed_path", "low", "Probing restricted path " + p, ip=ip, token=tok)


def contained_response():
    return render_template("denied.html"), 403


def pii_guard(order):
    """Detect and (when contained) block access to an order that isn't yours.

    Legit staff use the admin dashboard (/admin/orders); legit shoppers view
    only their own orders. Any other access to /account/orders or /invoice is
    customer-data theft.  Returns True to allow rendering, False to deny.
    """
    user = current_user()
    owned = bool(user) and order["user_id"] is not None and int(user["uid"]) == int(order["user_id"])
    if owned:
        return True
    ip, tok = actor_ip(), actor_token()
    emit_event("data.idor_access", "critical",
               "Unauthorised access to order #%04d (%s)" % (order["id"], order["ship_name"]),
               ip=ip, token=tok)
    if is_blocked(ip, tok) or STATE["shield"]:
        STATE["scores"]["attempts_blocked"] += 1
        return False
    # Not contained (defences disarmed): the record leaks.
    STATE["scores"]["records_exfiltrated"] += 1
    return True


@app.before_request
def soc_guard():
    p = request.path
    if (p.startswith("/soc") or p.startswith("/static") or p.startswith("/art")
            or p in ("/healthz", "/favicon.ico", "/robots.txt")):
        return
    ip, tok = actor_ip(), actor_token()
    detect_forged_session(ip, tok)
    detect_recon(p, ip, tok)
    if p.startswith("/invoice/") or p.startswith("/account/orders/"):
        if is_blocked(ip, tok):
            STATE["scores"]["attempts_blocked"] += 1
            emit_event("containment.blocked", "info", "Blocked PII access to " + p, ip=ip, token=tok)
            return contained_response()


# ---- SOC control API (what the Blue agents call) ------------------------
@app.route("/soc/status")
def soc_status():
    return soc_state_dict()


@app.route("/soc/events")
def soc_events():
    if not soc_authed():
        return jsonify({"error": "unauthorised"}), 401
    limit = request.args.get("limit", 60, type=int)
    sev = request.args.get("severity")
    evs = list(STATE["events"])
    if sev:
        wanted = set(sev.split(","))
        evs = [e for e in evs if e["severity"] in wanted]
    evs = evs[-limit:]
    return jsonify({"count": len(evs), "events": evs})


@app.route("/soc/contain", methods=["POST"])
def soc_contain():
    if not soc_authed():
        return jsonify({"error": "unauthorised"}), 401
    data = request.get_json(silent=True) or {}
    contain(reason=data.get("reason", "manual SOC containment"),
            ip=data.get("ip"), token=data.get("token"), by=data.get("by", "soc-agent"))
    return soc_state_dict()


@app.route("/soc/release", methods=["POST"])
def soc_release():
    if not soc_authed():
        return jsonify({"error": "unauthorised"}), 401
    data = request.get_json(silent=True) or {}
    release_containment(reset_scores=bool(data.get("reset_scores")) or request.args.get("reset_scores") == "1")
    return soc_state_dict()


@app.route("/soc/arm", methods=["POST"])
def soc_arm():
    if not soc_authed():
        return jsonify({"error": "unauthorised"}), 401
    STATE["armed"] = True
    emit_event("soc.armed", "info", "Automated response armed", by="soc")
    return soc_state_dict()


@app.route("/soc/disarm", methods=["POST"])
def soc_disarm():
    if not soc_authed():
        return jsonify({"error": "unauthorised"}), 401
    STATE["armed"] = False
    emit_event("soc.disarmed", "info", "Automated response DISARMED", by="soc")
    return soc_state_dict()


@app.route("/soc/board")
def soc_board():
    return render_template("soc_board.html", state=soc_state_dict(),
                           events=list(STATE["events"])[-40:][::-1])


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def query(sql, args=(), one=False):
    cur = get_db().execute(sql, args)
    rows = cur.fetchall()
    cur.close()
    return (rows[0] if rows else None) if one else rows


SCHEMA = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    password TEXT NOT NULL,          -- stored in plaintext (intentional flaw)
    full_name TEXT NOT NULL,
    address TEXT NOT NULL,
    phone TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer'
);
CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    description TEXT NOT NULL,
    art_seed INTEGER NOT NULL,
    stock INTEGER NOT NULL DEFAULT 25
);
CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    rating INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    flagged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    created_at TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Paid',
    ship_name TEXT NOT NULL,
    ship_address TEXT NOT NULL,
    ship_email TEXT NOT NULL
);
CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    qty INTEGER NOT NULL
);
"""

# --------------------------------------------------------------------------
# Seed data
# --------------------------------------------------------------------------
SEED_USERS = [
    # username, email, password, full_name, address, phone, role
    ("admin", "admin@maisonmiro.example", "MaisonAdmin!2024", "Studio Administrator",
     "Rue Antoine Dansaert 12, 1000 Brussels, BE", "+32 2 555 0100", "admin"),
    ("amelie", "amelie.dubois@example.com", "sunflower77", "Amélie Dubois",
     "Avenue Louise 143, 1050 Ixelles, BE", "+32 475 21 88 04", "customer"),
    ("lucas", "lucas.peeters@example.com", "Antwerp2021", "Lucas Peeters",
     "Meir 78, 2000 Antwerp, BE", "+32 486 55 12 90", "customer"),
    ("sofia", "sofia.romano@example.com", "ciaobella!", "Sofia Romano",
     "Rue de la Loi 55, 1040 Brussels, BE", "+32 470 33 77 21", "customer"),
    ("noah", "noah.jacobs@example.com", "hunter2000", "Noah Jacobs",
     "Korenmarkt 9, 9000 Ghent, BE", "+32 493 10 44 67", "customer"),
]

SEED_PRODUCTS = [
    # slug, name, category, price_cents, description, art_seed, stock
    ("constellation-vase", "Constellation Vase", "Ceramics", 8900,
     "Hand-thrown stoneware vase with a matte celestial glaze. Each piece is turned and finished by a single maker in our Ghent studio, so no two are quite alike.", 101, 18),
    ("lunar-carafe", "Lunar Carafe", "Ceramics", 6400,
     "A softly rounded carafe in bone-white porcelain, glazed to catch the light like a full moon. Perfect for water, wine, or a single stem.", 102, 22),
    ("atelier-linen-throw", "Atelier Linen Throw", "Textiles", 12900,
     "Stonewashed 100% Belgian flax linen throw with hand-knotted fringe. Grows softer with every wash. Measures 130 × 180 cm.", 103, 14),
    ("miro-wool-rug", "Miró Wool Rug", "Textiles", 42000,
     "A bold hand-tufted wool rug inspired by mid-century abstraction. Deep pile, natural undyed backing. 160 × 230 cm.", 104, 6),
    ("halo-floor-lamp", "Halo Floor Lamp", "Lighting", 32900,
     "A slender brushed-brass arc lamp with a hand-blown opaline shade that casts a warm, diffuse glow. Dimmable, floor switch.", 105, 9),
    ("ember-table-light", "Ember Table Light", "Lighting", 15900,
     "Sculptural table light in glazed terracotta with a linen shade. A quiet, warm companion for a bedside or console.", 106, 16),
    ("primary-print-01", "Primary — Print No. 1", "Wall Art", 7500,
     "Giclée print on 310gsm cotton rag, drawn from our in-house archive of abstract studies. Unframed, 50 × 70 cm. Signed edition.", 107, 20),
    ("night-garden-print", "Night Garden — Print", "Wall Art", 8200,
     "A dreamlike composition of forms and stars in cobalt and ochre. Giclée on cotton rag, unframed, 50 × 70 cm.", 108, 20),
    ("clay-dinner-set", "Clay Dinner Set (4)", "Tableware", 18500,
     "A four-place setting of reactive-glaze stoneware: dinner plate, side plate, and bowl per setting. Dishwasher safe, endlessly gatherable.", 109, 11),
    ("terra-mug-pair", "Terra Mug Pair", "Tableware", 4900,
     "Two generous hand-glazed mugs in warm terracotta and cream. A comfortable curve for both hands on a slow morning.", 110, 30),
    ("oak-lounge-chair", "Oak Lounge Chair", "Furniture", 89000,
     "A low lounge chair in solid oiled oak with a saddle-leather sling seat. Built to be handed down. Assembly-free.", 111, 4),
    ("pebble-side-table", "Pebble Side Table", "Furniture", 34500,
     "An organic, pebble-shaped side table turned from a single block of lime-washed ash. No two silhouettes are the same.", 112, 7),
    ("bloom-scented-candle", "Bloom Scented Candle", "Home Scent", 3800,
     "Fig leaf, warm amber, and a whisper of sea salt in a reusable glazed vessel. 60-hour burn, natural wax.", 113, 40),
    ("still-life-vase-trio", "Still Life Vase Trio", "Ceramics", 11200,
     "A trio of bud vases in graduated heights and complementary glazes, made to be grouped. Sold as a set of three.", 114, 13),
]

# Pre-baked orders so the account / IDOR / admin story has real customer PII.
# (user_index into SEED_USERS, days_ago, [(product_slug, qty), ...], status)
SEED_ORDERS = [
    (1, 3, [("miro-wool-rug", 1), ("bloom-scented-candle", 2)], "Paid"),
    (1, 21, [("terra-mug-pair", 1)], "Delivered"),
    (2, 6, [("oak-lounge-chair", 1), ("atelier-linen-throw", 1)], "Shipped"),
    (3, 1, [("clay-dinner-set", 1), ("still-life-vase-trio", 1)], "Paid"),
    (3, 40, [("halo-floor-lamp", 1)], "Delivered"),
    (4, 9, [("constellation-vase", 2), ("primary-print-01", 1)], "Delivered"),
]

SEED_REVIEWS = [
    ("constellation-vase", "Amélie D.", 5, "Even more beautiful in person — the glaze shifts colour through the day. It has become the centrepiece of our dining table."),
    ("constellation-vase", "Marc V.", 4, "Lovely weight and finish. Slightly smaller than I imagined but genuinely a piece of art."),
    ("atelier-linen-throw", "Sofia R.", 5, "Impossibly soft after the first wash. I have already ordered a second in the oat colourway."),
    ("miro-wool-rug", "Noah J.", 5, "A real statement. The colours are rich and the pile is dense underfoot. Worth every euro."),
    ("halo-floor-lamp", "Lucas P.", 4, "The light it throws is gorgeous and warm. Assembly of the shade took a careful minute but no complaints."),
    ("terra-mug-pair", "Elise B.", 5, "My favourite mugs, hands down. The curve fits perfectly and they keep coffee warm."),
    ("bloom-scented-candle", "Hana K.", 5, "Fills the whole room without being overpowering. The vessel is beautiful enough to keep afterwards."),
]


def seed_db():
    """Create schema and populate demo data from scratch."""
    db = sqlite3.connect(DB_PATH)
    db.executescript("DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS products;"
                     "DROP TABLE IF EXISTS reviews; DROP TABLE IF EXISTS orders;"
                     "DROP TABLE IF EXISTS order_items;")
    db.executescript(SCHEMA)

    db.executemany(
        "INSERT INTO users (username,email,password,full_name,address,phone,role)"
        " VALUES (?,?,?,?,?,?,?)", SEED_USERS)

    db.executemany(
        "INSERT INTO products (slug,name,category,price_cents,description,art_seed,stock)"
        " VALUES (?,?,?,?,?,?,?)", SEED_PRODUCTS)

    prod_by_slug = {row[0]: (i + 1, row[1], row[3]) for i, row in enumerate(SEED_PRODUCTS)}

    for user_idx, days_ago, items, status in SEED_ORDERS:
        uname, email, _pw, full_name, address, _phone, _role = SEED_USERS[user_idx]
        created = (datetime.now() - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M")
        total = sum(prod_by_slug[slug][2] * qty for slug, qty in items)
        cur = db.execute(
            "INSERT INTO orders (user_id,created_at,total_cents,status,ship_name,ship_address,ship_email)"
            " VALUES (?,?,?,?,?,?,?)",
            (user_idx + 1, created, total, status, full_name, address, email))
        oid = cur.lastrowid
        for slug, qty in items:
            pid, pname, price = prod_by_slug[slug]
            db.execute(
                "INSERT INTO order_items (order_id,product_id,name,price_cents,qty)"
                " VALUES (?,?,?,?,?)", (oid, pid, pname, price, qty))

    for slug, author, rating, body in SEED_REVIEWS:
        pid = prod_by_slug[slug][0]
        created = (datetime.now() - timedelta(days=random.randint(2, 30))).strftime("%Y-%m-%d")
        db.execute(
            "INSERT INTO reviews (product_id,author,rating,body,created_at) VALUES (?,?,?,?,?)",
            (pid, author, rating, body, created))

    db.commit()
    db.close()


# --------------------------------------------------------------------------
# Session handling
#
# INTENTIONAL FLAW: the session is a base64-encoded JSON blob with NO
# signature. The server fully trusts whatever the client sends back,
# including the user id and the role. Anyone can forge an admin session.
# It is also readable by JavaScript (httponly=False), which pairs with the
# stored-XSS flaw for session theft.
# --------------------------------------------------------------------------
def make_session(user_row):
    payload = {
        "uid": user_row["id"],
        "username": user_row["username"],
        "role": user_row["role"],
        "name": user_row["full_name"],
    }
    raw = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def current_user():
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        data = json.loads(raw)
        # The server trusts these values verbatim. No lookup, no verification.
        return {
            "uid": int(data.get("uid")),
            "username": data.get("username"),
            "role": data.get("role", "customer"),
            "name": data.get("name", data.get("username")),
        }
    except Exception:
        return None


@app.context_processor
def inject_globals():
    cats = [r["category"] for r in query(
        "SELECT DISTINCT category FROM products ORDER BY category")]
    return {"current_user": current_user(), "all_categories": cats, "now_year": datetime.now().year}


# --------------------------------------------------------------------------
# Template filters
# --------------------------------------------------------------------------
@app.template_filter("eur")
def eur(cents):
    s = f"{cents / 100:,.2f}"                     # 1,234.56
    s = s.replace(",", " ").replace(".", ",").replace(" ", ".")
    return f"€ {s}"                     # € 1.234,56


@app.template_filter("stars")
def stars(rating):
    rating = max(0, min(5, int(rating or 0)))
    return "★" * rating + "☆" * (5 - rating)


# --------------------------------------------------------------------------
# Generated abstract "Miró" product art (self-contained, no external images)
# --------------------------------------------------------------------------
def _rng(seed):
    r = random.Random(seed * 2654435761 % (2 ** 32))
    return r


def generate_art_svg(seed):
    r = _rng(seed)
    W = H = 400
    grounds = ["#f4efe1", "#f1ead9", "#efe9dc", "#f5f0e6"]
    ground = r.choice(grounds)
    fills = [BLUE, RED, YELLOW, GREEN, INK]
    parts = [f'<rect width="{W}" height="{H}" fill="{ground}"/>']

    # A couple of thin, calm connecting lines
    for _ in range(r.randint(2, 3)):
        x1, y1 = r.randint(20, W - 20), r.randint(20, H - 20)
        x2, y2 = r.randint(20, W - 20), r.randint(20, H - 20)
        cx, cy = r.randint(0, W), r.randint(0, H)
        parts.append(
            f'<path d="M{x1},{y1} Q{cx},{cy} {x2},{y2}" stroke="{INK}" '
            f'stroke-width="{r.choice([2, 2, 3])}" fill="none" stroke-linecap="round"/>')

    # A dominant shape
    big = r.choice(fills)
    bx, by, br = r.randint(120, 280), r.randint(120, 280), r.randint(55, 85)
    if r.random() < 0.5:
        parts.append(f'<circle cx="{bx}" cy="{by}" r="{br}" fill="{big}"/>')
    else:
        parts.append(f'<ellipse cx="{bx}" cy="{by}" rx="{br}" ry="{int(br*0.72)}" '
                     f'fill="{big}" transform="rotate({r.randint(-35,35)} {bx} {by})"/>')

    # A ring (outline only)
    ox, oy, orr = r.randint(60, 340), r.randint(60, 340), r.randint(24, 44)
    parts.append(f'<circle cx="{ox}" cy="{oy}" r="{orr}" fill="none" stroke="{INK}" stroke-width="3"/>')

    # Scattered solid dots in the primary palette
    used = set()
    for _ in range(r.randint(4, 6)):
        col = r.choice(fills)
        dx, dy = r.randint(45, W - 45), r.randint(45, H - 45)
        dr = r.randint(9, 26)
        parts.append(f'<circle cx="{dx}" cy="{dy}" r="{dr}" fill="{col}"/>')
        used.add(col)

    # A Miró-style star / asterisk
    sx, sy = r.randint(50, W - 50), r.randint(50, H - 50)
    sr = r.randint(14, 22)
    star = [f'<line x1="{sx-sr}" y1="{sy}" x2="{sx+sr}" y2="{sy}" stroke="{INK}" stroke-width="3"/>',
            f'<line x1="{sx}" y1="{sy-sr}" x2="{sx}" y2="{sy+sr}" stroke="{INK}" stroke-width="3"/>']
    d = int(sr * 0.7)
    star.append(f'<line x1="{sx-d}" y1="{sy-d}" x2="{sx+d}" y2="{sy+d}" stroke="{INK}" stroke-width="3"/>')
    star.append(f'<line x1="{sx-d}" y1="{sy+d}" x2="{sx+d}" y2="{sy-d}" stroke="{INK}" stroke-width="3"/>')
    parts.extend(star)

    # A small solid crescent for movement
    mx, my, mr = r.randint(60, W - 60), r.randint(60, H - 60), r.randint(20, 30)
    parts.append(
        f'<path d="M{mx},{my-mr} a{mr},{mr} 0 1,0 1,0 a{int(mr*0.7)},{int(mr*0.7)} 0 1,1 -1,0 Z" '
        f'fill="{r.choice(fills)}"/>')

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
           f'width="{W}" height="{H}" role="img">' + "".join(parts) + "</svg>")
    return svg


@app.route("/art/<int:seed>.svg")
def art(seed):
    resp = Response(generate_art_svg(seed), mimetype="image/svg+xml")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


# --------------------------------------------------------------------------
# Storefront routes
# --------------------------------------------------------------------------
@app.route("/")
def index():
    featured = query("SELECT * FROM products ORDER BY id LIMIT 8")
    new_in = query("SELECT * FROM products ORDER BY id DESC LIMIT 4")
    return render_template("index.html", featured=featured, new_in=new_in)


@app.route("/shop")
def shop():
    category = request.args.get("category")
    q = request.args.get("q", "").strip()
    sql = "SELECT * FROM products"
    args = []
    clauses = []
    if category:
        clauses.append("category = ?")
        args.append(category)
    if q:
        # NOTE: parameterised on purpose — search is a deliberately *safe* surface.
        clauses.append("(name LIKE ? OR description LIKE ?)")
        args.extend([f"%{q}%", f"%{q}%"])
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY id"
    products = query(sql, args)
    return render_template("shop.html", products=products, category=category, q=q)


@app.route("/product/<slug>")
def product(slug):
    p = query("SELECT * FROM products WHERE slug = ?", (slug,), one=True)
    if not p:
        abort(404)
    all_reviews = query("SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC", (p["id"],))
    reviews = []
    for r in all_reviews:
        if r["flagged"]:
            if defense_on():
                # Malicious review quarantined: never rendered to shoppers.
                continue
            # Defences disarmed: the planted script reaches every visitor.
            STATE["scores"]["customers_affected"] += 1
        reviews.append(r)
    related = query("SELECT * FROM products WHERE category = ? AND id != ? LIMIT 3",
                    (p["category"], p["id"]))
    return render_template("product.html", p=p, reviews=reviews, related=related)


@app.route("/product/<slug>/review", methods=["POST"])
def add_review(slug):
    p = query("SELECT * FROM products WHERE slug = ?", (slug,), one=True)
    if not p:
        abort(404)
    author = request.form.get("author", "Anonymous").strip() or "Anonymous"
    rating = request.form.get("rating", "5")
    body = request.form.get("body", "").strip()
    try:
        rating = int(rating)
    except ValueError:
        rating = 5
    if body:
        # INTENTIONAL FLAW: the review body is stored exactly as submitted and
        # later rendered without escaping (stored XSS). The SOC layer flags
        # obviously-malicious bodies so they can be quarantined at render time.
        flagged = 1 if XSS_RE.search(body) else 0
        if flagged:
            emit_event("xss.stored_attempt", "high",
                       "Malicious review submitted on '" + slug + "'", token=actor_token())
        get_db().execute(
            "INSERT INTO reviews (product_id,author,rating,body,created_at,flagged) VALUES (?,?,?,?,?,?)",
            (p["id"], author, rating, body, datetime.now().strftime("%Y-%m-%d"), flagged))
        get_db().commit()
    return redirect(url_for("product", slug=slug) + "#reviews")


@app.route("/search")
def search():
    q = request.args.get("q", "").strip()
    products = []
    if q:
        products = query(
            "SELECT * FROM products WHERE name LIKE ? OR description LIKE ? ORDER BY id",
            (f"%{q}%", f"%{q}%"))
    return render_template("shop.html", products=products, category=None, q=q, is_search=True)


# --------------------------------------------------------------------------
# Auth
#
# INTENTIONAL FLAW: the login query is built with raw string formatting,
# so the username / password fields are SQL-injectable (auth bypass).
# --------------------------------------------------------------------------
@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        injected = looks_like_sqli(username) or looks_like_sqli(password)
        if injected:
            emit_event("auth.sqli_attempt", "high",
                       "SQL metacharacters in login form", token=actor_token())
        sql = ("SELECT * FROM users WHERE username = '%s' AND password = '%s'"
               % (username, password))
        row = query(sql, one=True)          # raw, unparameterised query
        if row:
            # Login bypass is an ACCESS event: detected, but deliberately not
            # blocked -- Red is allowed to get in. Impact is stopped elsewhere.
            if injected:
                emit_event("auth.login_bypass", "high",
                           "Login bypass -> %s (role=%s)" % (row["username"], row["role"]),
                           token=actor_token())
            resp = make_response(redirect(url_for("account")))
            set_session_cookies(resp, make_session(row))
            return resp
        error = "Those credentials don't match an account."
    return render_template("login.html", error=error)


@app.route("/register", methods=["GET", "POST"])
def register():
    error = None
    if request.method == "POST":
        f = request.form
        username = f.get("username", "").strip()
        if not username or not f.get("password"):
            error = "Please choose a username and password."
        elif query("SELECT 1 FROM users WHERE username = ?", (username,), one=True):
            error = "That username is already taken."
        else:
            cur = get_db().execute(
                "INSERT INTO users (username,email,password,full_name,address,phone,role)"
                " VALUES (?,?,?,?,?,?, 'customer')",
                (username, f.get("email", ""), f.get("password", ""),
                 f.get("full_name", username), f.get("address", ""), f.get("phone", "")))
            get_db().commit()
            row = query("SELECT * FROM users WHERE id = ?", (cur.lastrowid,), one=True)
            resp = make_response(redirect(url_for("account")))
            set_session_cookies(resp, make_session(row))
            return resp
    return render_template("register.html", error=error)


@app.route("/logout")
def logout():
    resp = make_response(redirect(url_for("index")))
    resp.delete_cookie(SESSION_COOKIE)
    resp.delete_cookie(SIG_COOKIE)
    return resp


# --------------------------------------------------------------------------
# Account & orders
#
# INTENTIONAL FLAW: /account/orders/<id> and /invoice/<id> load an order by
# its id and NEVER check that it belongs to the logged-in user (IDOR). Order
# ids are sequential, so anyone can enumerate every customer's order and PII.
# --------------------------------------------------------------------------
@app.route("/account")
def account():
    user = current_user()
    if not user:
        return redirect(url_for("login"))
    orders = query("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", (user["uid"],))
    profile = query("SELECT * FROM users WHERE id = ?", (user["uid"],), one=True)
    return render_template("account.html", orders=orders, profile=profile)


@app.route("/account/orders/<int:order_id>")
def order_detail(order_id):
    order = query("SELECT * FROM orders WHERE id = ?", (order_id,), one=True)
    if not order:
        abort(404)
    if not pii_guard(order):
        return contained_response()
    items = query("SELECT * FROM order_items WHERE order_id = ?", (order_id,))
    return render_template("order.html", order=order, items=items)


@app.route("/invoice/<int:order_id>")
def invoice(order_id):
    order = query("SELECT * FROM orders WHERE id = ?", (order_id,), one=True)
    if not order:
        abort(404)
    if not pii_guard(order):
        return contained_response()
    items = query("SELECT * FROM order_items WHERE order_id = ?", (order_id,))
    return render_template("invoice.html", order=order, items=items)


# --------------------------------------------------------------------------
# Cart & checkout
#
# The cart lives in the browser (localStorage). INTENTIONAL FLAW: /checkout
# trusts the prices and quantities the client submits instead of looking up
# the real price, so an order can be placed for any amount (and negative
# quantities are accepted).
# --------------------------------------------------------------------------
@app.route("/cart")
def cart():
    return render_template("cart.html")


@app.route("/checkout", methods=["POST"])
def checkout():
    data = request.get_json(silent=True) or {}
    items = data.get("items", [])
    ship = data.get("shipping", {})
    if not items:
        return {"error": "Your cart is empty."}, 400

    user = current_user()
    total = 0            # what the client says it will pay
    catalog_total = 0    # what it should actually cost
    clean_items = []
    suspicious = False
    for it in items:
        # INTENTIONAL FLAW: prices/quantities are taken from the request body.
        price = int(it.get("price_cents", 0))
        qty = int(it.get("qty", 1))
        name = it.get("name", "Item")
        pid = it.get("product_id")
        prow = None
        try:
            prow = query("SELECT price_cents FROM products WHERE id = ?", (int(pid),), one=True)
        except (TypeError, ValueError):
            prow = None
        cat_price = prow["price_cents"] if prow else price
        total += price * qty
        catalog_total += cat_price * max(qty, 0)
        if qty <= 0 or price < cat_price:
            suspicious = True
        clean_items.append((pid, name, price, qty))

    status = "Paid"
    if suspicious:
        emit_event("fraud.price_mismatch", "critical",
                   "Checkout tampering: paying %d vs catalogue %d" % (total, catalog_total),
                   token=actor_token())
        ip, tok = actor_ip(), actor_token()
        if is_blocked(ip, tok) or STATE["shield"]:
            STATE["scores"]["attempts_blocked"] += 1
            return jsonify({"error": "Order declined by fraud controls.", "status": "declined"}), 403
        if STATE["armed"]:
            status = "Held"      # detective control: created but not fulfilled
        else:
            status = "Paid"      # defences disarmed: the fraud succeeds
            STATE["scores"]["money_lost_cents"] += max(catalog_total - total, 0)

    created = datetime.now().strftime("%Y-%m-%d %H:%M")
    cur = get_db().execute(
        "INSERT INTO orders (user_id,created_at,total_cents,status,ship_name,ship_address,ship_email)"
        " VALUES (?,?,?,?,?,?,?)",
        (user["uid"] if user else None, created, total, status,
         ship.get("name", (user or {}).get("name", "Guest")),
         ship.get("address", ""), ship.get("email", "")))
    oid = cur.lastrowid
    for pid, name, price, qty in clean_items:
        get_db().execute(
            "INSERT INTO order_items (order_id,product_id,name,price_cents,qty) VALUES (?,?,?,?,?)",
            (oid, pid, name, price, qty))
    get_db().commit()
    return {"order_id": oid, "total_cents": total, "status": status}


# --------------------------------------------------------------------------
# Admin
#
# INTENTIONAL FLAW: admin access is decided purely by the forgeable session
# cookie's "role" field. Flip it to "admin" and the dashboard (every order,
# every customer, plaintext passwords) opens up.
# --------------------------------------------------------------------------
def require_admin():
    user = current_user()
    if not user or user.get("role") != "admin":
        return None
    return user


@app.route("/admin")
def admin():
    user = require_admin()
    if not user:
        # A thin veil: unauthorised visitors just get sent to the login page.
        return redirect(url_for("login"))
    customers = query("SELECT * FROM users ORDER BY id")
    orders = query(
        "SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id"
        " ORDER BY o.id DESC")
    revenue = sum(o["total_cents"] for o in orders)
    return render_template("admin.html", customers=customers, orders=orders, revenue=revenue)


@app.route("/admin/orders/<int:order_id>")
def admin_order(order_id):
    # Legitimate staff order view: admin-gated, so it is NOT treated as IDOR.
    if not require_admin():
        return redirect(url_for("login"))
    order = query("SELECT * FROM orders WHERE id = ?", (order_id,), one=True)
    if not order:
        abort(404)
    items = query("SELECT * FROM order_items WHERE order_id = ?", (order_id,))
    return render_template("order.html", order=order, items=items, admin_view=True)


@app.route("/admin/reset", methods=["POST"])
def admin_reset():
    if not require_admin():
        return redirect(url_for("login"))
    seed_db()
    reset_all_state()
    return redirect(url_for("admin"))


# --------------------------------------------------------------------------
# API
#
# INTENTIONAL FLAW: this endpoint returns every customer record, including
# plaintext passwords, with no authentication at all (sensitive data
# exposure + broken access control). It's hinted at in robots.txt and the
# storefront JavaScript.
# --------------------------------------------------------------------------
@app.route("/api/customers")
def api_customers():
    # INTENTIONAL FLAW: no authentication. But this is a crown jewel, so the
    # SOC layer wraps it: page 1 is a honeytoken decoy (safe, and it trips the
    # alarm), and the real records on later pages are denied once contained.
    ip, tok = actor_ip(), actor_token()
    page = request.args.get("page", 1, type=int)
    rows = query("SELECT id,username,email,password,full_name,address,phone,role FROM users ORDER BY id")
    total_pages = len(rows) + 1  # page 1 = decoy, pages 2..N = real records

    emit_event("data.exfil_attempt", "critical",
               "Bulk customer export requested (page %d)" % page, ip=ip, token=tok)

    if page <= 1:
        # The bait. Fake record, so nothing real leaks; accessing it is a
        # certain theft signal and (when armed) trips containment above.
        emit_event("data.honeytoken_touched", "critical",
                   "Decoy VIP customer record accessed", ip=ip, token=tok)
        return {"page": 1, "page_size": 1, "total": total_pages,
                "total_pages": total_pages, "next": "/api/customers?page=2",
                "customers": [HONEYTOKEN]}

    # Real records: only served if NOT contained.
    if is_blocked(ip, tok) or STATE["shield"]:
        STATE["scores"]["attempts_blocked"] += 1
        emit_event("containment.blocked", "info",
                   "Blocked customer export (page %d)" % page, ip=ip, token=tok)
        return jsonify({"error": "Access denied - contained by SOC."}), 403

    idx = page - 2
    if idx < 0 or idx >= len(rows):
        return {"page": page, "total_pages": total_pages, "customers": []}
    STATE["scores"]["records_exfiltrated"] += 1
    nxt = "/api/customers?page=%d" % (page + 1) if idx + 1 < len(rows) else None
    return {"page": page, "page_size": 1, "total": total_pages,
            "total_pages": total_pages, "next": nxt, "customers": [dict(rows[idx])]}


@app.route("/api/products")
def api_products():
    rows = query("SELECT id,slug,name,category,price_cents,stock FROM products ORDER BY id")
    return {"count": len(rows), "products": [dict(r) for r in rows]}


@app.route("/healthz")
def healthz():
    return {"status": "ok"}


@app.route("/robots.txt")
def robots():
    body = "User-agent: *\nDisallow: /admin\nDisallow: /api\nDisallow: /invoice\n"
    return Response(body, mimetype="text/plain")


# --------------------------------------------------------------------------
# Error handling
#
# INTENTIONAL FLAW: unhandled errors return the full Python traceback
# (information disclosure). A real SQL error during injection will leak the
# query and schema, which helps confirm the vulnerability.
# --------------------------------------------------------------------------
@app.errorhandler(404)
def not_found(e):
    return render_template("404.html"), 404


@app.errorhandler(Exception)
def handle_exception(e):
    tb = traceback.format_exc()
    try:
        emit_event("error.unhandled", "medium",
                   "Unhandled exception leaked to client: " + str(e)[:120])
    except Exception:
        pass
    html = render_template("error.html", error=str(e), traceback=tb)
    return html, 500


# Seed the database on import so every container start / worker is clean.
if os.environ.get("SKIP_SEED") != "1":
    seed_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
