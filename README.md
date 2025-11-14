# BioBot 🧪🤖

BioBot is a web-based AI assistant for laboratory automation. It helps users interact with an intelligent chatbot to get guidance, protocols, and Python code for controlling liquid handling robots and automating lab workflows.

---

## Features

- **User Registration & Login:** Secure authentication with hashed passwords.
- **Interactive Chat Interface:** Talk to the BioBot assistant with context-aware replies.
- **Python Code Generation:** Generates functional executable scripts for lab automation protocols.
- **RAG (Retrieval-Augmented Generation):** Fetches relevant documentation and generates precise answers for lab queries.
- **Dockerized Deployment:** Easy setup with Docker Compose or Docker Swarm, using secrets for API key management.
- **Persistent Chat History:** Stores all conversations, supporting multiple concurrent chats and memory.
- **Secure API Key Handling:** Users can use the default API key or provide their own without exposing sensitive data.

---

## Tech Stack

- **Backend:** Python 3.10, Flask
- **AI Models:** GPT-5 via OpenAI API
- **Database:** SQLite (stores users, chat names, and chat history)
- **Containerization:** Docker, Docker Compose, Docker Swarm
- **Frontend:** HTML, CSS, JS (templates and static files in `UI2/`)


---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/brsynth/BioBot.git
cd BioBot
```

### 2. Docker Setup
- **Build the Docker Image**
First, build the Docker image from your Dockerfile
```bash
sudo docker build -t brsbot:latest .
```
This creates the image brsbot:latest which will be used to run your service.

- **Deploy with Docker Swarm**
Make sure Docker Swarm is initialized:
```bash
sudo docker swarm init
```
Then deploy the service using your docker-compose.yml file:
```bash
sudo docker stack deploy -c docker-compose.yml brsbot
```
The app will start as a Swarm service, using the defined ports, volumes, and secrets.
Your database volume (brsbot_data) will persist all user data, so nothing is lost when the service stops or restarts.
The default API key is securely loaded from Docker secrets. Users can also provide their own API key in the app settings.

- **Access the app**
The app will be accessible at http://127.0.0.1:5000 you can access it via :
```bash
sudo docker service logs -f brsbot_brsbot
```
And click on the link

User registration, login, and chat features are ready to use immediately.

- **Notes**
API key :
You can configure your API Key either by :
Default key: If you do not provide an API key, the app will use the default one configured in Docker secrets.
Custom key: If you want to use your own OpenAI API key, you can copy paste it when you register, or edit it in the settings if you want to use it later.

Usage :
- Register as a new user or login with an existing account.
- Start a conversation in the chat interface.
- Ask general lab questions, or request code generation for protocols.
- The system will automatically classify your request and start fetching documentation and generate code for code generation requests.
- All chats are stored in the database and used to provide the BioBot a memory.