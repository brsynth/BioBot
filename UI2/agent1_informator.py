# agent_1.py

from typing import Dict, Any
import json
import re, os
from openai import OpenAI

def get_api_key():
    secret_path = "/run/secrets/brsbot_api_key"
    if os.path.exists(secret_path):
        with open(secret_path, "r") as f:
            return f.read().strip()
    else:
        raise ValueError("API KEY not found")
      
MODEL = "gpt-5"

def get_openai_client(api_key=None):
    return OpenAI(api_key=api_key or get_api_key())

def agent_1_discover_tools(user_request: str, model = MODEL, api_key = None) -> Dict[str, Any]:
    """
    Agent 1:
    - Understands the robot mentioned in the user request
    - Discovers available code validation / simulation tools
    - Outputs structured JSON for downstream agents
    """
    client = get_openai_client(api_key)

    system_prompt = """
You are Agent 1: Robot Tooling Discovery Agent.

Your role:
- Analyze a user request related to laboratory automation or robotics.
- Identify the robot or platform mentioned.
- Determine whether executable code will be generated for this robot.
- Discover whether official or commonly used tools exist to:
  - simulate
  - validate
  - dry-run
  - or syntaxically check
  robot code without physical hardware.

Rules:
- You MUST rely on factual knowledge or web search results if needed.
- You MUST output a single valid JSON object.
- Do NOT include explanations, markdown, or natural language.
- Do NOT generate robot code or biological instructions.
- The goal is to know if we can check the syntax of a given code only by running it via api, library (pylabrobot,pyhamilton etc...) or a tool. Before using it with a robot.
- Recommand tools that can validate the syntax/typing in the code without physical hardware, software or interface. Only with a runnable script written in the langage supported by the liquid handler.

JSON_SCHEMA =
{
  "robot_platform": "",
  "user_intent": "",
  "will_generate_executable_code": true,

  "primary_api_or_format": [],

  "tools": [
    {
      "name": "",
      "capabilities": [],
      "hardware_required": false,
      "official": true,
      "notes": "",
      "install": "CMD",
      "usage_example": ""
    }
  ],

  "simulation_validation_via_code": {
    "supported": true,
    "scope": [
      "syntax",
      "typing",
      "api-usage",
      "robot-constraints"
    ],
    "notes": ""
  },

  "recommendation": "",
  "confidence": "high,medium,low"
}
"""
    messages=[
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": f"User request:\n\"{user_request}\""
            }
        ]
    response = client.responses.create(
        model=model,
        tools=[{"type": "web_search"}],
        input=messages
    )

    # Extract JSON safely
    output_text = response.output_text
    return json.loads(output_text)

def robot_name_to_filename(robot_name: str) -> str:
    name = robot_name.lower()
    name = re.sub(r"[^a-z0-9]+", "_", name)
    name = re.sub(r"_+", "_", name).strip("_")
    return f"{name}.json"


def save_agent_1_output(agent_output: dict, directory="robot_profiles"):
    robot_name = agent_output["robot_platform"]
    filename = robot_name_to_filename(robot_name)

    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, filename)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(agent_output, f, indent=2)

    return path



if __name__ == "__main__":
    user_input = "I need a serial dilution protocol for Hamilton star liquid handler"
    result = agent_1_discover_tools(user_input)
    file_path = save_agent_1_output(result)
    print("Agent 1 output saved to:", file_path)
