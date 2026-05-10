"""Tests for tool plugin architecture: ToolLoader, ToolContext, metadata."""
from __future__ import annotations

from dataclasses import fields
from typing import Any
from unittest.mock import MagicMock

import pytest

from nanobot.agent.tools.base import Tool


class _MinimalTool(Tool):
    @property
    def name(self) -> str:
        return "test_minimal"

    @property
    def description(self) -> str:
        return "A test tool"

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs: Any) -> Any:
        return "ok"


def test_tool_default_config_cls_is_none():
    assert _MinimalTool.config_cls() is None


def test_tool_default_config_key_is_empty():
    assert _MinimalTool.config_key == ""


def test_tool_default_enabled_is_true():
    assert _MinimalTool.enabled(None) is True


def test_tool_default_create_returns_instance():
    tool = _MinimalTool.create(None)
    assert isinstance(tool, _MinimalTool)
    assert tool.name == "test_minimal"


def test_tool_plugin_discoverable_default_is_true():
    assert _MinimalTool._plugin_discoverable is True


# --- ToolContext tests ---

from nanobot.agent.tools.context import ToolContext


def test_tool_context_has_required_fields():
    field_names = {f.name for f in fields(ToolContext)}
    required = {
        "config", "workspace", "bus", "subagent_manager",
        "cron_service", "file_state_store", "provider_snapshot_loader",
        "image_generation_provider_configs", "timezone",
    }
    assert required <= field_names


def test_tool_context_defaults():
    ctx = ToolContext(config=None, workspace="/tmp")
    assert ctx.bus is None
    assert ctx.subagent_manager is None
    assert ctx.cron_service is None
    assert ctx.provider_snapshot_loader is None
    assert ctx.image_generation_provider_configs is None
    assert ctx.timezone == "UTC"


# --- ToolLoader tests ---

from nanobot.agent.tools.loader import ToolLoader, _SKIP_MODULES


def test_skip_modules_excludes_infrastructure():
    infra = {"base", "schema", "registry", "context", "loader", "config",
             "file_state", "sandbox", "mcp", "__init__"}
    assert infra <= _SKIP_MODULES


def test_discover_finds_concrete_tools():
    loader = ToolLoader()
    discovered = loader.discover()
    class_names = {cls.__name__ for cls in discovered}
    assert "ExecTool" in class_names
    assert "MessageTool" in class_names
    assert "SpawnTool" in class_names


def test_discover_excludes_abstract_and_mcp():
    loader = ToolLoader()
    discovered = loader.discover()
    class_names = {cls.__name__ for cls in discovered}
    assert "_FsTool" not in class_names
    assert "_SearchTool" not in class_names
    assert "MCPToolWrapper" not in class_names
    assert "MCPResourceWrapper" not in class_names
    assert "MCPPromptWrapper" not in class_names


def test_discover_skips_private_classes():
    loader = ToolLoader()
    discovered = loader.discover()
    for cls in discovered:
        assert not cls.__name__.startswith("_")
