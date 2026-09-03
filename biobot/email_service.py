"""
email_service.py — Email service for BioBot

Sends transactional emails (password reset, etc.) via SMTP.
Configure via environment variables:
    SMTP_HOST=smtp.gmail.com
    SMTP_PORT=587
    SMTP_USER=biobot@yourdomain.com
    SMTP_PASSWORD=your-app-password
    SMTP_FROM=BioBot <biobot@yourdomain.com>

For Gmail: use an App Password (not your regular password).
For Outlook: use smtp-mail.outlook.com port 587.
For custom SMTP: any standard SMTP server works.
"""

import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


def get_smtp_config():
    return {
        "host": os.environ.get("SMTP_HOST", ""),
        "port": int(os.environ.get("SMTP_PORT", 587)),
        "user": os.environ.get("SMTP_USER", ""),
        "password": os.environ.get("SMTP_PASSWORD", ""),
        "from_addr": os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", "")),
    }


def is_email_configured():
    if os.environ.get("RESEND_API_KEY"):
        return True
    config = get_smtp_config()
    return bool(config["host"] and config["user"] and config["password"])


def send_email(to_email: str, subject: str, html_body: str, text_body: str = None):
    """
    Send an email. Tries Resend API first (simpler), falls back to SMTP.
    
    Configure ONE of:
      - RESEND_API_KEY (recommended — no email account needed)
      - SMTP_HOST + SMTP_USER + SMTP_PASSWORD (traditional)
    """
    # Try Resend first
    resend_key = os.environ.get("RESEND_API_KEY", "")
    if resend_key:
        _send_via_resend(to_email, subject, html_body, resend_key)
        return

    # Fall back to SMTP
    config = get_smtp_config()
    if config["host"]:
        _send_via_smtp(to_email, subject, html_body, text_body, config)
        return

    raise RuntimeError(
        "Email not configured. Set RESEND_API_KEY or SMTP_HOST+SMTP_USER+SMTP_PASSWORD."
    )


def _send_via_resend(to_email: str, subject: str, html_body: str, api_key: str):
    """Send email via Resend API (resend.com) — one HTTP call, no SMTP."""
    import requests as req

    from_addr = os.environ.get("EMAIL_FROM", "BioBot <onboarding@resend.dev>")

    resp = req.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "from": from_addr,
            "to": [to_email],
            "subject": subject,
            "html": html_body,
        },
        timeout=10,
    )

    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Resend API error: {resp.status_code} — {resp.text}")


def _send_via_smtp(to_email: str, subject: str, html_body: str,
                   text_body: str, config: dict):
    """Send email via traditional SMTP."""

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = config["from_addr"]
    msg["To"] = to_email

    if text_body:
        msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(config["host"], config["port"]) as server:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(config["user"], config["password"])
        server.sendmail(config["from_addr"], to_email, msg.as_string())


def send_password_reset_email(to_email: str, reset_url: str, user_name: str = ""):
    """Send a password reset email with a secure link."""

    display_name = user_name or "there"

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #121212; color: #e0e0e0; padding: 40px 20px; }}
            .container {{ max-width: 500px; margin: 0 auto; background: #1f1f1f; border-radius: 12px; padding: 40px; border: 1px solid #333; }}
            h1 {{ color: #00ff99; font-size: 22px; margin: 0 0 20px; }}
            p {{ color: #ccc; font-size: 15px; line-height: 1.6; margin: 0 0 16px; }}
            .btn {{ display: inline-block; background: #00ff99; color: #121212; font-weight: 700; font-size: 15px; padding: 14px 32px; border-radius: 8px; text-decoration: none; margin: 20px 0; }}
            .btn:hover {{ background: #00cc7a; }}
            .note {{ font-size: 13px; color: #888; margin-top: 24px; }}
            .footer {{ font-size: 12px; color: #555; margin-top: 32px; border-top: 1px solid #333; padding-top: 16px; }}
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🔬 BioBot — Password Reset</h1>
            <p>Hi {display_name},</p>
            <p>We received a request to reset your BioBot password. Click the button below to set a new one:</p>
            <a href="{reset_url}" class="btn">Reset My Password</a>
            <p class="note">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
            <div class="footer">
                <p>BioBot — Lab Automation Protocol Generator</p>
            </div>
        </div>
    </body>
    </html>
    """

    text = f"""BioBot — Password Reset

Hi {display_name},

We received a request to reset your BioBot password.
Click the link below to set a new one:

{reset_url}

This link expires in 1 hour.
If you didn't request this, you can safely ignore this email.

— BioBot
"""

    send_email(to_email, "BioBot — Reset Your Password", html, text)