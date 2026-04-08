FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml /app/
RUN pip install --no-cache-dir -U pip \
  && pip install --no-cache-dir .

COPY app /app/app

ENV PORT=8080
EXPOSE 8080

CMD ["python", "-m", "app.server"]
