# BioBot 🧪🤖

BioBot is a web application and chatbot designed for laboratory automation, particularly with liquid handling robots. It helps users interact with an AI assistant to get guidance, protocols, and code for automating lab workflows.

---

## Features

- **User Registration and Login:** Secure authentication system with hashed passwords.
- **Chat Interface:** Talk to the BioBot assistant with context-aware replies.
- **Code Generation:** Generates Python code for lab automation protocols.
- **RAG (Retrieval-Augmented Generation):** Fetches relevant documentation and generates answers for lab-related queries.
- **Dockerized Deployment:** Easy to deploy with Docker and Docker Swarm, supporting secrets for API keys.
- **Persistent Chat History:** Stores user chats and allows multiple concurrent conversations.
- **Secure API Key Handling:** Supports API key retrieval via Docker secrets or environment variables.

---

## Tech Stack

- **Backend:** Python 3.10, Flask
- **AI Models:** GPT-5 via OpenAI API
- **Database:** SQLite for storing users, chat history, and chat names
- **Containerization:** Docker, Docker Compose, Docker Swarm
- **Frontend:** HTML/CSS/JS (templates in `UI2/`)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/brsynth/BioBot.git
cd BioBot

2. Docker Setup
Using Docker Compose (local dev)
docker-compose up --build
The app will be accessible at http://127.0.0.1:5000
User registration, login, and chat features are ready to use immediately.

Using Docker Swarm (production-like setup)
docker stack deploy -c docker-compose.yml brsbot

2. Configure API Key
Default key: If you do not provide an API key, the app will use the default one configured in Docker secrets.
Custom key: If you want to use your own OpenAI API key, you can copy paste it when you register, or edit it in the settings if you want to use it later.

Usage

- Register as a new user or login with an existing account.
- Start a conversation in the chat interface.
- Ask general lab questions, or request code generation for protocols.
- The system will automatically classify your request and start fetching documentation and generate code for code generation requests.
- All chats are stored in the database and used to provide the BioBot a memory.