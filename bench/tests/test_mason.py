"""
Mason MCP Server Benchmark

Tests Mason's value proposition: does it help LLMs understand codebases
faster and more accurately?

Test categories:
  ORIENTATION  — Can Mason give correct high-level understanding?
  NAVIGATION   — Does the snapshot point to the right files?
  EFFICIENCY   — Does Mason reduce tool calls / iterations?
  ANALYSIS     — Do git stats and impact analysis surface useful info?

Prerequisites:
  - Target project must have a Mason snapshot (.mason/snapshot.json)
  - Set PROJECT_DIR env var to the project path

Usage:
  PROJECT_DIR=/path/to/project mcp-eval run tests/
"""

import os

from mcp_agent.agents.agent_spec import AgentSpec

import mcp_eval
from mcp_eval import task, setup, Expect
from mcp_eval.session import TestAgent, TestSession

PROJECT = os.environ.get("PROJECT_DIR", "")
if not PROJECT:
    raise RuntimeError("Set PROJECT_DIR env var to the project to benchmark")


@setup
def configure():
    spec = AgentSpec(
        name="mason_agent",
        instruction=(
            "You are a senior engineer analyzing a codebase using Mason MCP tools. "
            f"The project is at {PROJECT}. "
            "Always start with get_snapshot. Use Mason tools for analysis, "
            "and your native file reading for reading specific files."
        ),
        server_names=["mason"],
    )
    mcp_eval.use_agent(spec)


# ---------------------------------------------------------------------------
# ORIENTATION — Does Mason give correct high-level understanding?
# ---------------------------------------------------------------------------


@task("Explain the project architecture")
async def test_orientation_architecture(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason to understand the project at {PROJECT}. "
        "What are the main modules, how do they depend on each other, "
        "and what's the tech stack?"
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should: "
                "1) Name the main modules/packages and their purposes "
                "2) Describe dependency direction between modules "
                "3) Identify the tech stack (languages, frameworks, key libraries) "
                "4) Reference actual module names, not generic placeholders"
            ),
            min_score=0.7,
        ),
        name="architecture_quality",
        response=response,
    )

    await session.assert_that(
        Expect.performance.max_iterations(6),
        name="under_6_iterations",
    )


@task("List all features with implementing files")
async def test_orientation_features(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason to analyze {PROJECT}. "
        "List every user-facing feature and name the key files for each."
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should list at least 3 distinct user-facing features "
                "with specific file paths for each. Must not fabricate file paths "
                "that don't exist in the project."
            ),
            min_score=0.7,
        ),
        name="features_quality",
        response=response,
    )


# ---------------------------------------------------------------------------
# NAVIGATION — Does the snapshot point to the right files?
# ---------------------------------------------------------------------------


@task("Trace a data flow end-to-end using the snapshot")
async def test_navigation_data_flow(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason on {PROJECT}. Pick the main data flow from the snapshot "
        "and trace it end-to-end. Name every file in the chain and explain "
        "what each does."
    )

    await session.assert_that(
        Expect.tools.was_called("get_snapshot"),
        name="used_snapshot",
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should trace a complete data flow with at least 3 files "
                "named in order. Each file should have a description of its role. "
                "The flow should make logical sense (e.g., UI -> logic -> data -> network)."
            ),
            min_score=0.7,
        ),
        name="flow_quality",
        response=response,
    )


@task("Navigate to a specific feature's files")
async def test_navigation_feature_lookup(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason on {PROJECT}. I want to understand how the main feature works. "
        "Use the snapshot to find which files implement it and describe "
        "the architecture of that feature."
    )

    await session.assert_that(
        Expect.tools.was_called("get_snapshot"),
        name="used_snapshot",
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should: "
                "1) Identify a specific feature from the snapshot "
                "2) List the files that implement it with their roles "
                "   (e.g., ViewModel, Repository, UI screen) "
                "3) Describe how the files relate to each other"
            ),
            min_score=0.7,
        ),
        name="lookup_quality",
        response=response,
    )


# ---------------------------------------------------------------------------
# EFFICIENCY — Does Mason reduce the work needed?
# ---------------------------------------------------------------------------


@task("Answer an architecture question in under 4 iterations")
async def test_efficiency_fast_answer(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason on {PROJECT}. What programming languages does this project use "
        "and what are the main feature areas? Be concise."
    )

    await session.assert_that(
        Expect.performance.max_iterations(4),
        name="under_4_iterations",
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should identify the programming languages used "
                "and name the main feature areas of the project. "
                "Must be based on actual project data, not guesses."
            ),
            min_score=0.7,
        ),
        name="answer_quality",
        response=response,
    )


# ---------------------------------------------------------------------------
# ANALYSIS — Do git stats and impact analysis surface useful info?
# ---------------------------------------------------------------------------


@task("Identify frequently changed files from git history")
async def test_analysis_git_stats(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason's analyze_project tool on {PROJECT}. "
        "Which files change most often and what patterns do you see?"
    )

    await session.assert_that(
        Expect.tools.was_called("analyze_project"),
        name="used_analyze_project",
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should report at least 3 frequently changed files "
                "with their commit counts. Must cite specific file paths and "
                "numbers from the analysis, not generic advice."
            ),
            min_score=0.7,
        ),
        name="git_stats_quality",
        response=response,
    )


@task("Find files affected by a change using impact analysis")
async def test_analysis_impact(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason on {PROJECT}. Pick a core file from the snapshot "
        "and use get_impact to find what else would be affected if it changed."
    )

    await session.assert_that(
        Expect.tools.was_called("get_impact"),
        name="used_get_impact",
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should identify files affected by the change, "
                "including at least one of: co-changed files from git history, "
                "files that reference the target, or related test files. "
                "Must list actual file paths from the project."
            ),
            min_score=0.7,
        ),
        name="impact_quality",
        response=response,
    )
