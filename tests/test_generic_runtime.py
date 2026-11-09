"""Exercise device-neutral validation without loading the generation pipeline."""
import ast
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import re
import subprocess
import tempfile
import types
import unittest


class GenericValidationTests(unittest.TestCase):
    def test_simulators_receive_isolated_files_in_the_discovered_device_format(self):
        source = Path(__file__).resolve().parents[1] / "biobot/main_rag.py"
        function = next(node for node in ast.parse(source.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == "validate_simulation")
        paths = []

        def simulate(command, **kwargs):
            path = Path(command[-1])
            self.assertEqual(path.suffix, command[1])
            self.assertEqual(path.read_text(), "synthetic protocol")
            paths.append(path)
            return types.SimpleNamespace(returncode=0)

        namespace = dict(os=os, re=re, tempfile=tempfile,
                         subprocess=types.SimpleNamespace(run=simulate, TimeoutExpired=subprocess.TimeoutExpired))
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
        validate = namespace["validate_simulation"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda extension: validate("synthetic protocol", {
                "simulate_cmd": ["discovered_validator", extension], "file_extension": extension,
            }), [".wire", ".table"]))
        self.assertEqual(results, [(True, ""), (True, "")])
        self.assertEqual(len(set(paths)), 2)
        self.assertTrue(all(not path.exists() for path in paths))


if __name__ == "__main__":
    unittest.main()
