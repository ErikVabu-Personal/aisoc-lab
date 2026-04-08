FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml /app/pyproject.toml
COPY aisoc_runner /app/aisoc_runner

RUN pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir .

ENV PORT=8080
EXPOSE 8080

CMD ["python", "-m", "aisoc_runner.server"]
