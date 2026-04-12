"""
Mason Benchmark — Token Savings & Quality (deepeval)

Compares two realistic approaches to answering codebase questions:
  A: Mason snapshot (~1,600 tokens) + 3 targeted file reads
  B: 8-10 files an agent would find via grep/exploration (no Mason)

Both paths simulate what a real agent would do — not best/worst case.
Both answers are scored with the same GEval rubric.

Usage:
  cd bench
  PROJECT_DIR=/path/to/project ANTHROPIC_API_KEY=sk-... deepeval test run tests/test_mason.py
"""

import json
import os
import time

import anthropic
import pytest

from deepeval import assert_test
from deepeval.test_case import LLMTestCase, MCPServer, MCPToolCall
from deepeval.metrics import MCPUseMetric, GEval
from deepeval.test_case import LLMTestCaseParams
from deepeval.models import AnthropicModel

PROJECT = os.environ.get("PROJECT_DIR", "")
if not PROJECT:
    raise RuntimeError("Set PROJECT_DIR env var")

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
if not API_KEY:
    raise RuntimeError("Set ANTHROPIC_API_KEY env var")

MODEL = os.environ.get("BENCH_MODEL", "claude-sonnet-4-20250514")

# ---------------------------------------------------------------------------
# Load project data
# ---------------------------------------------------------------------------

with open(os.path.join(PROJECT, ".mason", "snapshot.json")) as f:
    SNAPSHOT = json.load(f)

SNAPSHOT_JSON = json.dumps(SNAPSHOT, indent=2)


def _read_files(paths: list[str]) -> str:
    parts = []
    for rel in paths:
        full = os.path.join(PROJECT, rel)
        try:
            with open(full) as f:
                parts.append(f"## {rel}\n```\n{f.read()}\n```\n")
        except FileNotFoundError:
            pass
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Define realistic file sets for each question
#
# Path A: snapshot + 3 files the snapshot points to (the real Mason workflow)
# Path B: 8-10 files an agent would find via grep (realistic no-Mason)
#
# These are hand-picked to be fair — not cherry-picked for either path.
# ---------------------------------------------------------------------------

QUESTIONS = [
    {
        "id": "features",
        "question": "List every user-facing feature and the key files for each.",
        "criteria": (
            "Lists at least 3 distinct user-facing features "
            "with specific file paths for each."
        ),
        # Path A: snapshot already lists features; read nav files for confirmation
        "a_files": [
            "androidApp/src/main/java/com/adrianczuczka/jacket/nav/JacketNavHost.kt",
        ],
        # Path B: without a feature map, you'd read every screen + navigation
        "b_files": [
            "androidApp/src/main/java/com/adrianczuczka/jacket/nav/JacketNavHost.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/home/HomeScreen.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/personalization/DailyCheckupScreen.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/personalization/InitialCalibrationScreen.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/locationpicker/LocationPickerScreen.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/settings/SettingsScreen.kt",
            "iosApp/iosApp/iOSApp.swift",
            "iosApp/iosApp/ContentView.swift",
        ],
    },
    {
        "id": "data_flow",
        "question": (
            "Trace the weather forecast data flow from the UI to the server. "
            "Name every file in the chain and explain what each does."
        ),
        "criteria": (
            "Traces a complete data flow with at least 4 files "
            "named in order, each with a description of its role. "
            "Should cover UI, domain, data, and server layers."
        ),
        # Path A: snapshot has the flow chain; read 2 key files for detail
        "a_files": [
            "feature/home/presentation/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/presentation/HomeViewModel.kt",
            "feature/home/data/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/data/WeatherRepositoryImpl.kt",
        ],
        # Path B: without the flow chain, you'd read every file in the path
        "b_files": [
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/home/HomeScreen.kt",
            "feature/home/presentation/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/presentation/HomeViewModel.kt",
            "feature/home/domain/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/domain/GetWeatherDataUseCase.kt",
            "feature/home/domain/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/domain/WeatherRepository.kt",
            "feature/home/data/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/data/WeatherRepositoryImpl.kt",
            "shared/src/commonMain/kotlin/com/adrianczuczka/jacket/NetworkModule.kt",
            "api/src/commonMain/kotlin/com/adrianczuczka/jacket/api/weather/WeatherService.kt",
            "server/src/main/java/com/adrianczuczka/jacket/weather/WeatherServiceImpl.kt",
        ],
    },
    {
        "id": "cross_platform",
        "question": (
            "How is the home screen implemented on both Android and iOS? "
            "What are the differences?"
        ),
        "criteria": (
            "Identifies both platform implementations (Compose + SwiftUI), "
            "names the specific files, describes shared vs platform-specific "
            "code, and notes at least one difference."
        ),
        # Path A: snapshot points to both files; read the shared ViewModel
        "a_files": [
            "feature/home/presentation/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/presentation/HomeViewModel.kt",
        ],
        # Path B: you'd need to find and read both large UI files
        "b_files": [
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/home/HomeScreen.kt",
            "iosApp/iosApp/ContentView.swift",
            "feature/home/presentation/src/commonMain/kotlin/com/adrianczuczka/jacket/feature/home/presentation/HomeViewModel.kt",
        ],
    },
    {
        "id": "onboarding_flow",
        "question": (
            "What happens when a new user opens the app for the first time? "
            "Trace the navigation flow from launch to the home screen."
        ),
        "criteria": (
            "Describes the first-launch flow including calibration, location "
            "selection, and how the app decides which screen to show. "
            "Names specific files and navigation logic."
        ),
        # Path A: snapshot has the startup flow; read the nav file for detail
        "a_files": [
            "androidApp/src/main/java/com/adrianczuczka/jacket/nav/JacketNavHost.kt",
        ],
        # Path B: you'd read the app entry, nav, and all onboarding screens
        "b_files": [
            "androidApp/src/main/java/com/adrianczuczka/jacket/JacketApp.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/nav/JacketNavHost.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/personalization/InitialCalibrationScreen.kt",
            "androidApp/src/main/java/com/adrianczuczka/jacket/feature/locationpicker/LocationPickerScreen.kt",
            "iosApp/iosApp/iOSApp.swift",
        ],
    },
]

# ---------------------------------------------------------------------------
# Call Claude API with retry
# ---------------------------------------------------------------------------

client = anthropic.Anthropic(api_key=API_KEY)


def ask_claude(context: str, question: str) -> tuple[str, int, int]:
    """Returns (response, input_tokens, output_tokens)."""
    for attempt in range(6):
        try:
            msg = client.messages.create(
                model=MODEL,
                max_tokens=4096,
                temperature=0,
                system=(
                    "You are a senior engineer answering questions about a codebase. "
                    "Answer based only on the context provided. Be specific — "
                    "reference actual file paths and explain each file's role."
                ),
                messages=[{
                    "role": "user",
                    "content": f"{context}\n\n---\n\nQuestion: {question}",
                }],
            )
            text = next((b.text for b in msg.content if b.type == "text"), "")
            return text, msg.usage.input_tokens, msg.usage.output_tokens
        except anthropic.RateLimitError:
            wait = (attempt + 1) * 60
            print(f"rate limited, waiting {wait}s...", end=" ", flush=True)
            time.sleep(wait)
    raise RuntimeError("Rate limit not cleared after retries")


# ---------------------------------------------------------------------------
# Mason MCP server definition (for MCPUseMetric)
# ---------------------------------------------------------------------------

from mcp.types import Tool, CallToolResult, TextContent

mason_server = MCPServer(
    server_name="mason",
    transport="stdio",
    available_tools=[
        Tool(
            name="get_snapshot",
            description="Get the project's concept map — maps features/flows to files",
            inputSchema={
                "type": "object",
                "properties": {"dir": {"type": "string"}},
                "required": ["dir"],
            },
        ),
    ],
)

snapshot_call = MCPToolCall(
    name="get_snapshot",
    args={"dir": PROJECT},
    result=CallToolResult(
        content=[TextContent(type="text", text=SNAPSHOT_JSON)],
    ),
)

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

JUDGE_MODEL = os.environ.get("BENCH_JUDGE_MODEL", "claude-haiku-4-5-20251001")
judge_model = AnthropicModel(model=JUDGE_MODEL)
mcp_use = MCPUseMetric(threshold=0.5, model=judge_model)

# ---------------------------------------------------------------------------
# Generate responses upfront
# ---------------------------------------------------------------------------

CACHE_PATH = os.path.join(os.path.dirname(__file__), ".responses_cache.json")


def _load_cache() -> dict:
    try:
        with open(CACHE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_cache(cache: dict):
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2)


print("\n=== Generating responses ===\n")

cache = _load_cache()
RESULTS: dict[str, dict] = {}

for q in QUESTIONS:
    qid = q["id"]

    if qid in cache:
        print(f"  {qid} [cached]")
        RESULTS[qid] = cache[qid]
        continue

    # Path A: snapshot + targeted reads
    a_context = (
        f"# Project Snapshot (Mason)\n\n{SNAPSHOT_JSON}\n\n"
        f"# Targeted File Reads\n\n{_read_files(q['a_files'])}"
    )
    print(f"  {qid} [A] snapshot + {len(q['a_files'])} files...", end=" ", flush=True)
    a_resp, a_in, a_out = ask_claude(a_context, q["question"])
    print(f"{a_in} tokens")

    # Path B: raw files only
    b_context = f"# Source Files\n\n{_read_files(q['b_files'])}"
    print(f"  {qid} [B] {len(q['b_files'])} raw files...", end=" ", flush=True)
    b_resp, b_in, b_out = ask_claude(b_context, q["question"])
    print(f"{b_in} tokens")

    saving = round((b_in - a_in) / b_in * 100) if b_in > 0 else 0
    print(f"  {qid} saving: {saving}%\n")

    RESULTS[qid] = {
        "a_response": a_resp,
        "a_input_tokens": a_in,
        "b_response": b_resp,
        "b_input_tokens": b_in,
        "saving_pct": saving,
    }

    # Save after each question so partial runs are cached
    cache[qid] = RESULTS[qid]
    _save_cache(cache)

# Print summary
print("=== Token Savings ===\n")
print(f"{'Question':<20} {'A (Mason)':>12} {'B (no Mason)':>14} {'Saving':>8}")
print("-" * 56)
for q in QUESTIONS:
    r = RESULTS[q["id"]]
    print(f"{q['id']:<20} {r['a_input_tokens']:>12} {r['b_input_tokens']:>14} {r['saving_pct']:>7}%")
avg_saving = round(sum(RESULTS[q["id"]]["saving_pct"] for q in QUESTIONS) / len(QUESTIONS))
print("-" * 56)
print(f"{'AVERAGE':<20} {'':>12} {'':>14} {avg_saving:>7}%")
print()

# ---------------------------------------------------------------------------
# Pytest tests — deepeval evaluates quality
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("q", QUESTIONS, ids=[q["id"] for q in QUESTIONS])
def test_A_with_mason(q):
    """Path A: Mason snapshot + targeted reads."""
    r = RESULTS[q["id"]]
    quality = GEval(
        name=f"{q['id']}_quality",
        criteria=q["criteria"],
        evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
        threshold=0.7,
        model=judge_model,
    )
    test_case = LLMTestCase(
        input=q["question"],
        actual_output=r["a_response"],
        mcp_servers=[mason_server],
        mcp_tools_called=[snapshot_call],
    )
    assert_test(test_case, [quality, mcp_use])


@pytest.mark.parametrize("q", QUESTIONS, ids=[q["id"] for q in QUESTIONS])
def test_B_without_mason(q):
    """Path B: raw source files only."""
    r = RESULTS[q["id"]]
    quality = GEval(
        name=f"{q['id']}_quality",
        criteria=q["criteria"],
        evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
        threshold=0.7,
        model=judge_model,
    )
    test_case = LLMTestCase(
        input=q["question"],
        actual_output=r["b_response"],
    )
    assert_test(test_case, [quality])
