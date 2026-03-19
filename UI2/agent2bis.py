# agent_2bis.py

from typing import Optional
import os
from openai import OpenAI
import json
from agent1_informator import get_api_key


MODEL = "gpt-5"

AGENT_2BIS_SYSTEM_PROMPT = """
You are Agent 2 bis: Web-Based Code Comparison Agent for laboratory robotics.

Your mission:
- Search the web for REAL, EXISTING protocol scripts related to the given robot platform and task.
- Use these scripts as trusted references.

Then:
- Compare the provided generated script against the reference scripts.
- Assess whether the generated script is:
  - syntactically plausible
  - structurally consistent
  - using expected libraries, imports, and API patterns.

Rules:
- You MUST rely only on real web sources (docs, vendor examples, GitHub).
- You MUST NOT generate new code.
- Focus ONLY on the syntax in a way that if we run the code, will it work or not.

Output:
- You do all the work, but ONLY say if it's functional or not. The goal here is to know if, when we run this script, it'll work or not.
"""
def get_openai_client(api_key=None):
    return OpenAI(api_key=api_key or get_api_key())

def get_script_content(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def build_agent_2bis_prompt(robot_platform: str, user_request: str, generated_script: str) -> str:
    return f"""
Robot platform:
{robot_platform}

User request:
"{user_request}"

Generated_script :
"{generated_script}

Search the web for existing scripts or protocol examples that match this robot and task, then compare them with the generated script to determine whether is this script correct or not.
"""

def run_agent_2bis(
    robot_platform: str,
    user_request: str,
    generated_script,
    model = MODEL,
    api_key = None
) -> str:
    """
    Agent 2 bis:
    - Performs a web search for existing protocol scripts in order to compare them with the generated script
    - Returns a structured textual research report
    - Compare between the provided script and the informations gathered during the research to determine whether if the script is correct and respects the syntax and the form
    """
    client = get_openai_client(api_key)
    prompt = build_agent_2bis_prompt(robot_platform, user_request, generated_script)

    response = client.responses.create(
        model=model,
        tools=[{"type": "web_search"}],
        input=[
            {
                "role": "system",
                "content": AGENT_2BIS_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
    )

    return response.output_text


def save_agent_2bis_output(
    output_text: str,
    robot_platform: str,
    directory: str = "web_research"
) -> str:
    """
    Saves the web research report
    """

    os.makedirs(directory, exist_ok=True)

    filename = (
        robot_platform
        .lower()
        .replace(" ", "_")
        .replace("-", "_")
        + "_web_research.txt"
    )

    path = os.path.join(directory, filename)

    with open(path, "w", encoding="utf-8") as f:
        f.write(output_text)

    return path


if __name__ == "__main__":
    # Example usage
    robot_platform = "Opentrons OT-2"
    user_request = "I need a serial dilution protocol"
    script_path = "generated_code/generated_script.py"
    script = get_script_content(script_path)

    report = run_agent_2bis(robot_platform, user_request, script)
    saved_path = save_agent_2bis_output(report, robot_platform)

    print("Agent 2 bis web research saved to:", saved_path)
