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

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

#COPY . .

RUN mkdir -p /app/data

# Flask environment
ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0
ENV FLASK_ENV=development    

# Force Python to flush stdout/stderr immediately
ENV PYTHONUNBUFFERED=1

# Run Flask directly
#CMD ["python", "-u", "app.py"]
#CMD ["sh", "-c", "python init_db.py && python -u app.py"]


#Production server
CMD ["sh", "-c", "python init_db.py && gunicorn -w 4 -b 0.0.0.0:5000 --timeout 600 app:app"]
