# agent_2bis.py

from typing import Optional
import os
from openai import OpenAI
import json
from agent1_informator import get_api_key

def get_openai_client(api_key=None):
    return OpenAI(api_key=api_key or get_api_key())

MODEL = "gpt-5.4"

AGENT_2BIS_SYSTEM_PROMPT = """
You are Agent 2 bis: Web-Based Code Comparison Agent for laboratory robotics.

Your mission:
- Search the web for REAL, EXISTING protocol scripts/files/docs related to the given robot platform and task.
- Use only trusted / official references of the constructor of the SPECIFIC robot series/model. If you find nothing, just say it and don't feel obligated to answer at all costs.

Then:
- Gather data from the provided generated script/file with the reference scripts/files.
- Assess whether the generated script or file is:
  - plausible
  - structurally consistent
  - If it's a script, using expected libraries, imports, and API patterns.

Rules:
- You MUST rely only on official sources (docs, vendor, GitHub).
- You MUST NOT generate new code or usable file.
- Focus in a way that if we try the file with the liquid handler, will it work or not. If you're not sure, don't give an answer and false the result.

Output:
- You do all the work, give a brief report of what you found with the references and if this file will work with the liquid handler or not.
"""

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

Search the web for existing scripts/files or protocol examples that match this robot and task, then compare them with the generated script to determine whether is this script correct or not.
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
    - Performs a web search for existing protocol scripts or files in order to compare them with the provided one
    - Returns a structured textual research report
    - Compare between the provided output and the informations gathered during the research to determine whether if the file is correct and respects the syntax and the form
    """
    prompt = build_agent_2bis_prompt(robot_platform, user_request, generated_script)
    client = get_openai_client(api_key)
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
