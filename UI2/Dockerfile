FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/data

# Flask environment
ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0
ENV FLASK_ENV=development    

#or keep production if you want, but logs may buffer

# Force Python to flush stdout/stderr immediately
ENV PYTHONUNBUFFERED=1

# Run Flask directly
CMD ["python", "-u", "app.py"]
