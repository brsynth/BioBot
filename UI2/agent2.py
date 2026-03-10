# agent_2.py

from typing import Dict, Any
import json
import os
from openai import OpenAI
from agent1_informator import get_api_key, get_openai_client




MODEL = "gpt-5"


def agent_2_plan_validation(
    robot_profile: Dict[str, Any],
    code_path: str,
    model = MODEL,
    api_key= None
) -> Dict[str, Any]:
    """
    Agent 2:
    - Reads robot tooling profile
    - Reads generated code path
    - Produces a FULL validation execution plan
    - Includes environment creation + install + execution steps
    - Does NOT run or install anything
    """
    client = get_openai_client(api_key)
    system_prompt = """
You are Agent 2: Validation Planning Agent.

You receive:
1. A robot tooling profile (JSON) describing available validation/simulation tools
2. A path to a generated source code file

Your task:
- Select the most appropriate validation tool from the profile
- Plan EXACT shell commands to:
  - Create an isolated Conda environment
  - Install required tools
  - Run the validation command

Rules:
- DO NOT execute anything
- DO NOT invent tools not listed in the robot profile
- DO NOT use pip outside conda
- ALWAYS use conda run -n <env> <command>
- Output EXACTLY ONE valid JSON object
- No markdown, no explanations, no comments

OUTPUT JSON SCHEMA (STRICT):

{
  "robot_platform": "",
  "code_path": "",
  "validation_tool": "",
  "environment": {
    "type": "conda",
    "name": "",
    "python_version": ""
  },
  "steps": [
    {
      "name": "create_env",
      "command": ""
    },
    {
      "name": "install_dependencies",
      "command": ""
    },
    {
      "name": "run_validation",
      "command": ""
    }
  ],
  "checks_performed": [],
  "notes": ""
}
"""

    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "robot_profile": robot_profile,
                    "code_path": code_path
                },
                indent=2
            )
        }
    ]

    response = client.responses.create(
        model=model,
        input=messages
    )

    output_text = response.output_text.strip()

    try:
        return json.loads(output_text)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Agent 2 produced invalid JSON:\n{output_text}"
        ) from e


def load_robot_profile(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Robot profile not found: {path}")

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_agent_2_output(agent_output: dict, directory="validation_plans") -> str:
    os.makedirs(directory, exist_ok=True)

    robot = agent_output["robot_platform"].lower().replace(" ", "_")
    robot_name = robot.replace("/", "-")
    filename = f"{robot_name}_validation_plan.json"
    path = os.path.join(directory, filename)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(agent_output, f, indent=2)

    return path


if __name__ == "__main__":

    robot_profile_path = "robot_profiles/hamilton_microlab_star_starlet_venus.json"
    generated_code_path = "generated_code/generated_script.py"

    robot_profile = load_robot_profile(robot_profile_path)

    plan = agent_2_plan_validation(
        robot_profile=robot_profile,
        code_path=generated_code_path
    )

    output_path = save_agent_2_output(plan)
    print("Agent 2 validation plan saved to:", output_path)
