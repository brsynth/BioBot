FROM python:3.10-slim
WORKDIR /app

# System dependencies for PyMuPDF (PDF parsing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmupdf-dev \
    libfreetype6-dev \
    libharfbuzz-dev \
    libjpeg-dev \
    libopenjp2-7-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (requirements.txt is at project root)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code from biobot/ into /app/
COPY biobot/ .
RUN mkdir -p /app/data

# Flask environment
ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0
ENV FLASK_ENV=development

# Force Python to flush stdout/stderr immediately
ENV PYTHONUNBUFFERED=1

# Production server — threaded workers required for streaming
CMD ["sh", "-c", "python init_db.py && gunicorn \
    -w 1 \
    --threads 8 \
    --worker-class gthread \
    -b 0.0.0.0:5000 \
    --timeout 1800 \
    --graceful-timeout 1800 \
    --keep-alive 120 \
    app:app"]