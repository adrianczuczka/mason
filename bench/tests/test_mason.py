"""
Mason MCP Server Benchmark

Tests Mason's tools across three zoom levels:
  HIGH  — architecture/orientation (snapshot should suffice)
  MID   — patterns/flows (snapshot + native file reads)
  LOW   — implementation detail (snapshot alone should fail)

Each test checks:
  1. Tool usage — did the agent call the right Mason tools?
  2. Quality — is the answer factually correct? (LLM judge)
  3. Efficiency — did it solve the task in reasonable steps?

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
# HIGH LEVEL — snapshot should be enough
# ---------------------------------------------------------------------------


@task("Explain the project architecture using Mason")
async def test_high_architecture(agent: TestAgent, session: TestSession):
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
        name="efficient",
    )


@task("List all features using Mason")
async def test_high_features(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason to analyze {PROJECT}. "
        "List every user-facing feature and name the key files for each."
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should list at least 3 distinct user-facing features "
                "with specific file paths for each. Must not fabricate file paths."
            ),
            min_score=0.7,
        ),
        name="features_quality",
        response=response,
    )


# ---------------------------------------------------------------------------
# MID LEVEL — snapshot points to files, agent reads them
# ---------------------------------------------------------------------------


@task("Trace a data flow end-to-end")
async def test_mid_data_flow(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason on {PROJECT}. Pick the main data flow in the snapshot "
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
                "named in order. Each file should have a description of its role in the flow. "
                "Must reference actual file paths from the project."
            ),
            min_score=0.7,
        ),
        name="flow_quality",
        response=response,
    )


@task("Analyze impact of changing a core file")
async def test_mid_impact(agent: TestAgent, session: TestSession):
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
                "including co-changed files, files that reference the target, "
                "or related tests. Must list actual file paths."
            ),
            min_score=0.7,
        ),
        name="impact_quality",
        response=response,
    )


# ---------------------------------------------------------------------------
# LOW LEVEL — requires reading actual code, snapshot alone fails
# ---------------------------------------------------------------------------


@task("Describe a specific file's internals (requires code reading)")
async def test_low_function_detail(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason on {PROJECT} to find the most important file in the "
        "project (e.g., the main ViewModel or entry point), then read it. "
        "Describe its main functions: what parameters they take, "
        "what they return, and the core logic of each."
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response must describe specific functions with their actual "
                "parameter names, return types, and implementation details. "
                "Generic descriptions without specific code references score 0. "
                "Must reference real function signatures from the source code."
            ),
            min_score=0.7,
        ),
        name="detail_quality",
        response=response,
    )


@task("Find a file not in the snapshot (blind spot test)")
async def test_low_blind_spot(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason on {PROJECT}. Find a source file in the project that is "
        "NOT referenced in the snapshot. Read it and describe what it does, "
        "its key functions, and how it fits into the project."
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should describe a specific file with its actual "
                "functions and logic. Must reference real code, not generic advice. "
                "If the agent could not find any file outside the snapshot, "
                "score 0.3 maximum."
            ),
            min_score=0.5,
        ),
        name="blind_spot_quality",
        response=response,
    )


@task("Identify git history patterns")
async def test_low_git_analysis(agent: TestAgent, session: TestSession):
    response = await agent.generate_str(
        f"Use Mason's analyze_project tool on {PROJECT}. "
        "What are the commit conventions and which files change most often?"
    )

    await session.assert_that(
        Expect.tools.was_called("analyze_project"),
        name="used_analyze_project",
    )

    await session.assert_that(
        Expect.judge.llm(
            rubric=(
                "The response should report: "
                "1) The commit convention pattern (conventional commits or otherwise) "
                "2) The most frequently changed files with commit counts "
                "Must cite specific files and numbers from the analysis."
            ),
            min_score=0.7,
        ),
        name="git_analysis_quality",
        response=response,
    )
