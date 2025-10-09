# BioRSBot 🧪🤖

BioRSBot is an advanced web application and chatbot designed for laboratory automation, particularly with liquid handling robots like the Opentrons OT-2. It helps users interact with an AI assistant to get guidance, protocols, and Python code for automating lab workflows.

---

## Features

- **User Registration and Login:** Secure authentication system with hashed passwords.
- **Chat Interface:** Talk to the BioRSBot assistant with context-aware replies.
- **Code Generation:** Generates Python code for lab automation protocols.
- **RAG (Retrieval-Augmented Generation):** Fetches relevant documentation and generates answers for lab-related queries.
- **Dockerized Deployment:** Easy to deploy with Docker and Docker Swarm, supporting secrets for API keys.
- **Persistent Chat History:** Stores user chats and allows multiple concurrent conversations.
- **Secure API Key Handling:** Supports API key retrieval via Docker secrets or environment variables.

---

## Tech Stack

- **Backend:** Python 3.10, Flask
- **AI Models:** GPT-5 via OpenAI API, Mistral classifier
- **Database:** SQLite for storing users, chat history, and chat names
- **Containerization:** Docker, Docker Compose, Docker Swarm
- **Frontend:** HTML/CSS/JS (templates in `UI2/`)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/BioRSBot.git
cd BioRSBot

2. Docker Setup
Using Docker Compose (local dev)
docker-compose up --build
The app will be accessible at http://127.0.0.1:5000

Make sure you have your OpenAI API key and other secrets handled via .env or mounted secrets.

Using Docker Swarm (production-like setup)
docker stack deploy -c docker-compose.yml brsbot
