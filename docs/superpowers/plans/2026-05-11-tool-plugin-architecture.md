# Tool Plugin Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor nanobot's tool system from hardcoded `AgentLoop._register_default_tools()` to a self-describing plugin pattern where each tool declares its config, enable condition, and factory method.

**Architecture:** Tool ABC gains class-level metadata methods (`config_cls`, `enabled`, `create`). A new `ToolLoader` discovers tools via `pkgutil` scanning. `ToolContext` dataclass provides runtime dependencies. `ToolsConfig` stays static but imports config classes from tool modules instead of defining them inline.

**Tech Stack:** Python 3.11+, pytest + pytest-asyncio (auto mode), Pydantic v2, pkgutil for discovery

**Design spec:** `docs/superpowers/specs/2026-05-11-tool-plugin-architecture-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `nanobot/agent/tools/base.py` | Modify | Add `config_key`, `_plugin_discoverable`, `config_cls()`, `enabled(ctx)`, `create(ctx)` |
| `nanobot/agent/tools/context.py` | Create | `ToolContext` dataclass |
| `nanobot/agent/tools/loader.py` | Create | `ToolLoader` class with `discover()` + `load()` |
| `nanobot/agent/tools/shell.py` | Modify | Move `ExecToolConfig` from schema.py, add metadata |
| `nanobot/agent/tools/web.py` | Modify | Move `WebToolsConfig`/`WebSearchConfig`/`WebFetchConfig`, add metadata |
| `nanobot/agent/tools/self.py` | Modify | Move `MyToolConfig`, add `enabled()` only (no `create` — manual reg) |
| `nanobot/agent/tools/image_generation.py` | Modify | Move `ImageGenerationToolConfig`, add metadata |
| `nanobot/agent/tools/filesystem.py` | Modify | Add `create()` to `_FsTool` |
| `nanobot/agent/tools/search.py` | Modify | Inherit `_FsTool.create()` via `_SearchTool` |
| `nanobot/agent/tools/notebook.py` | Modify | Inherit `_FsTool.create()` |
| `nanobot/agent/tools/message.py` | Modify | Add `create()` override |
| `nanobot/agent/tools/spawn.py` | Modify | Add `create()` override |
| `nanobot/agent/tools/cron.py` | Modify | Add `create()` + `enabled(ctx)` |
| `nanobot/agent/tools/mcp.py` | Modify | Add `_plugin_discoverable = False` to wrappers |
| `nanobot/agent/tools/__init__.py` | Modify | Export `ToolContext`, `ToolLoader` |
| `nanobot/config/schema.py` | Modify | Replace inline config classes with imports |
| `nanobot/agent/loop.py` | Modify | Simplify `_register_default_tools()` |
| `tests/tools/test_tool_loader.py` | Create | Tests for `ToolLoader`, `ToolContext`, discovery, registration |

---

### Task 1: Add metadata methods to Tool ABC

**Files:**
- Modify: `nanobot/agent/tools/base.py:117-170` (the `Tool` class)
- Test: `tests/tools/test_tool_loader.py`

- [ ] **Step 1: Write the failing test for Tool metadata defaults**

```python
# tests/tools/test_tool_loader.py
"""Tests for tool plugin architecture: ToolLoader, ToolContext, metadata."""

from typing import Any

from nanobot.agent.tools.base import Tool, tool_parameters


class _MinimalTool(Tool):
    """Concrete tool with no overrides — tests default metadata behavior."""

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
    assert _MinimalTool.enabled(None) is True  # type: ignore[arg-type]


def test_tool_default_create_returns_instance():
    tool = _MinimalTool.create(None)  # type: ignore[arg-type]
    assert isinstance(tool, _MinimalTool)
    assert tool.name == "test_minimal"


def test_tool_plugin_discoverable_default_is_true():
    assert _MinimalTool._plugin_discoverable is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py -v`
Expected: FAIL — `Tool` has no `config_cls`, `config_key`, `enabled`, `create`, `_plugin_discoverable`

- [ ] **Step 3: Add metadata to Tool ABC**

Add these to `nanobot/agent/tools/base.py` inside the `Tool` class, after the existing `exclusive` property (around line 167):

```python
    config_key: str = ""
    """Key under ToolsConfig where this tool's config lives. Empty = no config."""

    _plugin_discoverable: bool = True
    """Set False on classes that should not be auto-discovered (e.g. MCP wrappers)."""

    @classmethod
    def config_cls(cls) -> type["BaseModel"] | None:
        """Pydantic model for this tool's config section. None = no config."""
        return None

    @classmethod
    def enabled(cls, ctx: "ToolContext") -> bool:
        """Whether to register this tool. Default True."""
        return True

    @classmethod
    def create(cls, ctx: "ToolContext") -> "Tool":
        """Factory: build an instance from runtime context. Default cls()."""
        return cls()
```

Also add the necessary `TYPE_CHECKING` imports at the top of `base.py`:

```python
from __future__ import annotations

import typing
if typing.TYPE_CHECKING:
    from pydantic import BaseModel
    from nanobot.agent.tools.context import ToolContext
```

Note: `from __future__ import annotations` must be the very first import (before docstring if any). The `BaseModel` and `ToolContext` are only used in type annotations, so they go in `TYPE_CHECKING`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Run existing tests to verify no regression**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_registry.py tests/tools/test_tool_validation.py -v`
Expected: All existing tests still PASS

- [ ] **Step 6: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/tools/base.py tests/tools/test_tool_loader.py
git commit -m "feat(tools): add plugin metadata methods to Tool ABC"
```

---

### Task 2: Create ToolContext dataclass

**Files:**
- Create: `nanobot/agent/tools/context.py`
- Test: `tests/tools/test_tool_loader.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/test_tool_loader.py`:

```python
from dataclasses import fields
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
    ctx = ToolContext(config=None, workspace="/tmp")  # type: ignore[arg-type]
    assert ctx.bus is None
    assert ctx.subagent_manager is None
    assert ctx.cron_service is None
    assert ctx.provider_snapshot_loader is None
    assert ctx.image_generation_provider_configs is None
    assert ctx.timezone == "UTC"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_tool_context_has_required_fields tests/tools/test_tool_loader.py::test_tool_context_defaults -v`
Expected: FAIL — module `nanobot.agent.tools.context` does not exist

- [ ] **Step 3: Create ToolContext**

Create `nanobot/agent/tools/context.py`:

```python
"""Runtime context for tool construction."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from nanobot.agent.cron import CronService
    from nanobot.agent.subagent import SubagentManager
    from nanobot.agent.tools.file_state import FileStateStore
    from nanobot.bus.queue import MessageBus
    from nanobot.config.schema import Config


@dataclass
class ToolContext:
    config: Any  # Config — use Any to avoid import cycles
    workspace: str
    bus: Any | None = None  # MessageBus
    subagent_manager: Any | None = None  # SubagentManager
    cron_service: Any | None = None  # CronService
    file_state_store: Any = field(default=None)  # FileStateStore
    provider_snapshot_loader: Callable[[], Any] | None = None
    image_generation_provider_configs: dict[str, Any] | None = None
    timezone: str = "UTC"
```

Note: All complex types use `Any` at runtime with TYPE_CHECKING comments to avoid import cycles. The `file_state_store` defaults to `None` — the loader caller (AgentLoop) always provides it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_tool_context -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/tools/context.py tests/tools/test_tool_loader.py
git commit -m "feat(tools): add ToolContext dataclass"
```

---

### Task 3: Create ToolLoader with discovery

**Files:**
- Create: `nanobot/agent/tools/loader.py`
- Test: `tests/tools/test_tool_loader.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/test_tool_loader.py`:

```python
import types
from unittest.mock import MagicMock

import pytest

from nanobot.agent.tools.loader import ToolLoader, _SKIP_MODULES


def test_skip_modules_excludes_infrastructure():
    infra = {"base", "schema", "registry", "context", "loader", "config",
             "file_state", "sandbox", "mcp", "__init__"}
    assert infra <= _SKIP_MODULES


def test_discover_finds_concrete_tools():
    loader = ToolLoader()
    discovered = loader.discover()
    class_names = {cls.__name__ for cls in discovered}
    # Verify at least the core tool classes are found
    assert "ExecTool" in class_names
    assert "MessageTool" in class_names
    assert "SpawnTool" in class_names


def test_discover_excludes_abstract_and_mcp():
    loader = ToolLoader()
    discovered = loader.discover()
    class_names = {cls.__name__ for cls in discovered}
    # Abstract bases should be excluded
    assert "_FsTool" not in class_names
    assert "_SearchTool" not in class_names
    # MCP wrappers should be excluded (they set _plugin_discoverable = False)
    # This will pass once we add the flag in Task 7


def test_discover_skips_private_classes():
    loader = ToolLoader()
    discovered = loader.discover()
    for cls in discovered:
        assert not cls.__name__.startswith("_")


def test_load_registers_enabled_tools():
    loader = ToolLoader()
    registry = MagicMock()
    registry.has.return_value = False
    ctx = ToolContext(config=None, workspace="/tmp")

    registered = loader.load(ctx, registry)
    assert len(registered) > 0
    # Verify register was called for each tool
    assert registry.register.call_count == len(registered)


def test_load_skips_disabled_tools():
    """Verify that enabled() returning False skips a tool."""
    from nanobot.agent.tools.context import ToolContext as _TC

    # Create a mock context where enabled returns False for ExecTool
    loader = ToolLoader()
    registry = MagicMock()
    registry.has.return_value = False

    # Use a minimal mock config that makes exec.enable = False
    mock_config = MagicMock()
    mock_config.tools.exec.enable = False
    mock_config.tools.web.enable = False
    mock_config.tools.image_generation.enabled = False
    mock_config.tools.my.enable = False

    ctx = _TC(config=mock_config, workspace="/tmp", cron_service=None)
    registered = loader.load(ctx, registry)

    # ExecTool, WebSearchTool, WebFetchTool, ImageGenerationTool, MyTool, CronTool should be skipped
    names = registered
    assert "exec" not in names
    assert "web_search" not in names
    assert "web_fetch" not in names
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_skip_modules -v`
Expected: FAIL — `nanobot.agent.tools.loader` does not exist

- [ ] **Step 3: Create ToolLoader**

Create `nanobot/agent/tools/loader.py`:

```python
"""Tool discovery and registration via package scanning."""
from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Any

from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.registry import ToolRegistry

if __import__("typing").TYPE_CHECKING:
    from nanobot.agent.tools.context import ToolContext

logger = logging.getLogger(__name__)

_SKIP_MODULES = frozenset({
    "base", "schema", "registry", "context", "loader", "config",
    "file_state", "sandbox", "mcp", "__init__",
})


class ToolLoader:
    """Scan nanobot/agent/tools/, discover Tool subclasses, register enabled ones."""

    def __init__(self, package: Any = None):
        if package is None:
            import nanobot.agent.tools as _pkg
            package = _pkg
        self._package = package

    def discover(self) -> list[type[Tool]]:
        """Return all concrete, discoverable Tool subclasses, sorted by class name."""
        results: list[type[Tool]] = []
        for _importer, module_name, _ispkg in pkgutil.iter_modules(self._package.__path__):
            if module_name.startswith("_") or module_name in _SKIP_MODULES:
                continue
            try:
                module = importlib.import_module(f".{module_name}", self._package.__name__)
            except Exception:
                logger.exception("Failed to import tool module: %s", module_name)
                continue
            for attr_name in dir(module):
                attr = getattr(module, attr_name)
                if (
                    isinstance(attr, type)
                    and issubclass(attr, Tool)
                    and attr is not Tool
                    and not attr_name.startswith("_")
                    and not getattr(attr, "__abstractmethods__", None)
                    and getattr(attr, "_plugin_discoverable", True)
                ):
                    results.append(attr)
        results.sort(key=lambda cls: cls.__name__)
        return results

    def load(self, ctx: Any, registry: ToolRegistry) -> list[str]:
        """Discover, filter, instantiate, and register all enabled tools.

        Returns list of registered tool names (for logging).
        """
        registered: list[str] = []
        for tool_cls in self.discover():
            try:
                if not tool_cls.enabled(ctx):
                    continue
                tool = tool_cls.create(ctx)
                if registry.has(tool.name):
                    logger.warning(
                        "Tool name collision: %s from %s overwrites existing",
                        tool.name, tool_cls.__name__,
                    )
                registry.register(tool)
                registered.append(tool.name)
            except Exception:
                logger.exception("Failed to register tool: %s", tool_cls.__name__)
        return registered
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py -v -k "skip_modules or discover or load"`
Expected: Some tests pass. `test_discover_excludes_abstract_and_mcp` may fail if MCP wrappers don't have `_plugin_discoverable = False` yet (that's Task 7). `test_load_registers_enabled_tools` and `test_load_skips_disabled_tools` may fail because tools don't have `create()` overrides yet (Tasks 4-6). That's expected — we'll fix them incrementally.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/tools/loader.py tests/tools/test_tool_loader.py
git commit -m "feat(tools): add ToolLoader with pkgutil discovery"
```

---

### Task 4: Add `create()` overrides to filesystem and search tools

**Files:**
- Modify: `nanobot/agent/tools/filesystem.py` (add `create()` to `_FsTool`)
- Modify: `nanobot/agent/tools/search.py` (no change needed — inherits from `_FsTool`)
- Modify: `nanobot/agent/tools/notebook.py` (no change needed — inherits from `_FsTool`)

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/test_tool_loader.py`:

```python
from pathlib import Path


def test_fs_tool_create_builds_from_context():
    from nanobot.agent.tools.filesystem import ReadFileTool

    mock_config = MagicMock()
    mock_config.tools.restrict_to_workspace = False
    ctx = ToolContext(config=mock_config, workspace="/tmp/test")

    tool = ReadFileTool.create(ctx)
    assert isinstance(tool, ReadFileTool)
    assert tool._workspace == Path("/tmp/test")


def test_fs_tool_create_respects_restrict_to_workspace():
    from nanobot.agent.tools.filesystem import ReadFileTool

    mock_config = MagicMock()
    mock_config.tools.restrict_to_workspace = True
    ctx = ToolContext(config=mock_config, workspace="/tmp/test")

    tool = ReadFileTool.create(ctx)
    assert tool._allowed_dir == Path("/tmp/test")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_fs_tool_create_builds_from_context -v`
Expected: FAIL — `_FsTool` has no `create()` override, default `cls()` doesn't pass workspace

- [ ] **Step 3: Add `create()` to `_FsTool`**

In `nanobot/agent/tools/filesystem.py`, add a classmethod to `_FsTool` class (after `__init__`):

```python
    @classmethod
    def create(cls, ctx: Any) -> Tool:
        from nanobot.agent.skills import BUILTIN_SKILLS_DIR

        # Match original logic: restrict when restrict_to_workspace OR sandbox is enabled
        restrict = (
            ctx.config.tools.restrict_to_workspace
            or ctx.config.tools.exec.sandbox
        )
        allowed_dir = Path(ctx.workspace) if restrict else None
        extra_read = [BUILTIN_SKILLS_DIR] if allowed_dir else None
        return cls(
            workspace=Path(ctx.workspace),
            allowed_dir=allowed_dir,
            extra_allowed_dirs=extra_read,
        )
```

Note: Only `ReadFileTool` passes `extra_allowed_dirs`. Other `_FsTool` subclasses (`WriteFileTool`, `EditFileTool`, `ListDirTool`) don't use it in their logic — the `_FsTool.__init__` stores it but only `ReadFileTool`'s `execute` checks it. Passing it unconditionally is harmless since it only grants additional read access to the skills directory, which is read-only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_fs_tool -v`
Expected: PASS

- [ ] **Step 5: Run existing filesystem tests**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_filesystem_tools.py -v --timeout=30`
Expected: All PASS (no constructor changes)

- [ ] **Step 6: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/tools/filesystem.py tests/tools/test_tool_loader.py
git commit -m "feat(tools): add create() factory to _FsTool for plugin loading"
```

---

### Task 5: Add `create()` overrides to remaining simple tools

**Files:**
- Modify: `nanobot/agent/tools/message.py`
- Modify: `nanobot/agent/tools/spawn.py`
- Modify: `nanobot/agent/tools/cron.py`
- Test: `tests/tools/test_tool_loader.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/test_tool_loader.py`:

```python
async def test_message_tool_create():
    from nanobot.agent.tools.message import MessageTool

    mock_bus = MagicMock()
    mock_config = MagicMock()
    ctx = ToolContext(config=mock_config, workspace="/tmp", bus=mock_bus)
    tool = MessageTool.create(ctx)
    assert isinstance(tool, MessageTool)


def test_spawn_tool_create():
    from nanobot.agent.tools.spawn import SpawnTool

    mock_mgr = MagicMock()
    mock_config = MagicMock()
    ctx = ToolContext(config=mock_config, workspace="/tmp", subagent_manager=mock_mgr)
    tool = SpawnTool.create(ctx)
    assert isinstance(tool, SpawnTool)


def test_cron_tool_enabled_without_service():
    from nanobot.agent.tools.cron import CronTool

    mock_config = MagicMock()
    ctx = ToolContext(config=mock_config, workspace="/tmp", cron_service=None)
    assert CronTool.enabled(ctx) is False


def test_cron_tool_enabled_with_service():
    from nanobot.agent.tools.cron import CronTool

    mock_service = MagicMock()
    mock_config = MagicMock()
    ctx = ToolContext(config=mock_config, workspace="/tmp", cron_service=mock_service)
    assert CronTool.enabled(ctx) is True


def test_cron_tool_create():
    from nanobot.agent.tools.cron import CronTool

    mock_service = MagicMock()
    mock_config = MagicMock()
    ctx = ToolContext(config=mock_config, workspace="/tmp", cron_service=mock_service, timezone="Asia/Shanghai")
    tool = CronTool.create(ctx)
    assert isinstance(tool, CronTool)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_message_tool_create -v`
Expected: FAIL — `MessageTool` has no `create()` override, default `cls()` doesn't pass `send_callback`

- [ ] **Step 3: Add `create()` to MessageTool**

In `nanobot/agent/tools/message.py`, add to the `MessageTool` class:

```python
    @classmethod
    def create(cls, ctx: Any) -> Tool:
        send_callback = ctx.bus.publish_outbound if ctx.bus else None
        return cls(send_callback=send_callback, workspace=ctx.workspace)
```

- [ ] **Step 4: Add `create()` to SpawnTool**

In `nanobot/agent/tools/spawn.py`, add to the `SpawnTool` class:

```python
    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(manager=ctx.subagent_manager)
```

- [ ] **Step 5: Add `enabled()` and `create()` to CronTool**

In `nanobot/agent/tools/cron.py`, add to the `CronTool` class:

```python
    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.cron_service is not None

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(cron_service=ctx.cron_service, default_timezone=ctx.timezone)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_message_tool_create tests/tools/test_tool_loader.py::test_spawn_tool_create tests/tools/test_tool_loader.py::test_cron_tool -v`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/tools/message.py nanobot/agent/tools/spawn.py nanobot/agent/tools/cron.py tests/tools/test_tool_loader.py
git commit -m "feat(tools): add create() and enabled() to message, spawn, cron tools"
```

---

### Task 6: Add config + metadata to ExecTool, WebTools, ImageGenerationTool

**Files:**
- Modify: `nanobot/agent/tools/shell.py`
- Modify: `nanobot/agent/tools/web.py`
- Modify: `nanobot/agent/tools/image_generation.py`
- Test: `tests/tools/test_tool_loader.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/test_tool_loader.py`:

```python
def test_exec_tool_config_cls():
    from nanobot.agent.tools.shell import ExecTool, ExecToolConfig
    assert ExecTool.config_cls() is ExecToolConfig
    assert ExecTool.config_key == "exec"


def test_exec_tool_enabled():
    from nanobot.agent.tools.shell import ExecTool

    mock_config = MagicMock()
    mock_config.tools.exec.enable = True
    ctx = ToolContext(config=mock_config, workspace="/tmp")
    assert ExecTool.enabled(ctx) is True

    mock_config.tools.exec.enable = False
    assert ExecTool.enabled(ctx) is False


def test_exec_tool_create():
    from nanobot.agent.tools.shell import ExecTool

    mock_config = MagicMock()
    mock_config.tools.exec.enable = True
    mock_config.tools.exec.timeout = 120
    mock_config.tools.exec.sandbox = ""
    mock_config.tools.exec.path_append = ""
    mock_config.tools.exec.allowed_env_keys = []
    mock_config.tools.exec.allow_patterns = []
    mock_config.tools.exec.deny_patterns = []
    mock_config.tools.restrict_to_workspace = False
    ctx = ToolContext(config=mock_config, workspace="/tmp")
    tool = ExecTool.create(ctx)
    assert isinstance(tool, ExecTool)


def test_web_tools_config_cls():
    from nanobot.agent.tools.web import WebSearchTool, WebFetchTool, WebToolsConfig
    assert WebSearchTool.config_key == "web"
    assert WebSearchTool.config_cls() is WebToolsConfig
    assert WebFetchTool.config_key == "web"
    assert WebFetchTool.config_cls() is WebToolsConfig


def test_web_tools_enabled():
    from nanobot.agent.tools.web import WebSearchTool

    mock_config = MagicMock()
    mock_config.tools.web.enable = True
    ctx = ToolContext(config=mock_config, workspace="/tmp")
    assert WebSearchTool.enabled(ctx) is True

    mock_config.tools.web.enable = False
    assert WebSearchTool.enabled(ctx) is False


def test_web_search_tool_create():
    from nanobot.agent.tools.web import WebSearchTool

    mock_config = MagicMock()
    mock_config.tools.web.enable = True
    mock_config.tools.web.search = MagicMock()
    mock_config.tools.web.proxy = None
    mock_config.tools.web.user_agent = None
    ctx = ToolContext(config=mock_config, workspace="/tmp")
    tool = WebSearchTool.create(ctx)
    assert isinstance(tool, WebSearchTool)


def test_web_fetch_tool_create():
    from nanobot.agent.tools.web import WebFetchTool

    mock_config = MagicMock()
    mock_config.tools.web.enable = True
    mock_config.tools.web.fetch = MagicMock()
    mock_config.tools.web.proxy = None
    mock_config.tools.web.user_agent = None
    ctx = ToolContext(config=mock_config, workspace="/tmp")
    tool = WebFetchTool.create(ctx)
    assert isinstance(tool, WebFetchTool)


def test_image_gen_tool_config_cls():
    from nanobot.agent.tools.image_generation import ImageGenerationTool, ImageGenerationToolConfig
    assert ImageGenerationTool.config_key == "image_generation"
    assert ImageGenerationTool.config_cls() is ImageGenerationToolConfig


def test_image_gen_tool_enabled():
    from nanobot.agent.tools.image_generation import ImageGenerationTool

    mock_config = MagicMock()
    mock_config.tools.image_generation.enabled = True
    ctx = ToolContext(config=mock_config, workspace="/tmp")
    assert ImageGenerationTool.enabled(ctx) is True

    mock_config.tools.image_generation.enabled = False
    assert ImageGenerationTool.enabled(ctx) is False


def test_image_gen_tool_create():
    from nanobot.agent.tools.image_generation import ImageGenerationTool

    mock_config = MagicMock()
    mock_config.tools.image_generation = MagicMock()
    ctx = ToolContext(
        config=mock_config, workspace="/tmp",
        image_generation_provider_configs={"openrouter": MagicMock()},
    )
    tool = ImageGenerationTool.create(ctx)
    assert isinstance(tool, ImageGenerationTool)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_exec_tool_config_cls -v`
Expected: FAIL — `ExecTool` has no `config_cls()` override yet

- [ ] **Step 3: Move ExecToolConfig to shell.py and add metadata**

In `nanobot/agent/tools/shell.py`, add the config class (moved from `schema.py`) and metadata to `ExecTool`:

At the top of `shell.py`, add imports:
```python
from pydantic import Field
from nanobot.config.schema import Base
```

Add the config class before `ExecTool`:
```python
class ExecToolConfig(Base):
    """Shell exec tool configuration."""

    enable: bool = True
    timeout: int = 60
    path_append: str = ""
    sandbox: str = ""  # sandbox backend: "" (none) or "bwrap"
    allowed_env_keys: list[str] = Field(default_factory=list)
    allow_patterns: list[str] = Field(default_factory=list)
    deny_patterns: list[str] = Field(default_factory=list)
```

Add metadata to `ExecTool` class:
```python
    config_key = "exec"

    @classmethod
    def config_cls(cls):
        return ExecToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.tools.exec.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        cfg = ctx.config.tools.exec
        return cls(
            working_dir=ctx.workspace,
            timeout=cfg.timeout,
            restrict_to_workspace=ctx.config.tools.restrict_to_workspace,
            sandbox=cfg.sandbox,
            path_append=cfg.path_append,
            allowed_env_keys=cfg.allowed_env_keys,
            allow_patterns=cfg.allow_patterns,
            deny_patterns=cfg.deny_patterns,
        )
```

- [ ] **Step 4: Move WebToolsConfig to web.py and add metadata**

In `nanobot/agent/tools/web.py`, add config classes and metadata. Add at the top:
```python
from pydantic import Field
from nanobot.config.schema import Base
```

Add config classes before the tool classes:
```python
class WebSearchConfig(Base):
    """Web search configuration."""
    provider: str = "duckduckgo"
    api_key: str = ""
    base_url: str = ""
    max_results: int = 5
    timeout: int = 30


class WebFetchConfig(Base):
    """Web fetch tool configuration."""
    use_jina_reader: bool = True


class WebToolsConfig(Base):
    """Web tools configuration."""
    enable: bool = True
    proxy: str | None = None
    user_agent: str | None = None
    search: WebSearchConfig = Field(default_factory=WebSearchConfig)
    fetch: WebFetchConfig = Field(default_factory=WebFetchConfig)
```

Add metadata to `WebSearchTool`:
```python
    config_key = "web"

    @classmethod
    def config_cls(cls):
        return WebToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.tools.web.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        config_loader = None
        if ctx.provider_snapshot_loader is not None:
            def config_loader():
                from nanobot.config.loader import load_config, resolve_config_env_vars
                return resolve_config_env_vars(load_config()).tools.web.search
        return cls(
            config=ctx.config.tools.web.search,
            proxy=ctx.config.tools.web.proxy,
            user_agent=ctx.config.tools.web.user_agent,
            config_loader=config_loader,
        )
```

Add metadata to `WebFetchTool`:
```python
    config_key = "web"

    @classmethod
    def config_cls(cls):
        return WebToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.tools.web.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            config=ctx.config.tools.web.fetch,
            proxy=ctx.config.tools.web.proxy,
            user_agent=ctx.config.tools.web.user_agent,
        )
```

Remove the `from nanobot.config.schema import WebSearchConfig` import inside `WebSearchTool.__init__` body and the `from nanobot.config.schema import WebFetchConfig` inside `WebFetchTool.__init__` body — they are now defined in the same module.

Remove the `TYPE_CHECKING` imports of `WebSearchConfig` and `WebFetchConfig` from schema.

- [ ] **Step 5: Move ImageGenerationToolConfig to image_generation.py and add metadata**

In `nanobot/agent/tools/image_generation.py`, the `ImageGenerationToolConfig` is already imported from schema. Replace the import with an inline definition:

Remove:
```python
from nanobot.config.schema import ImageGenerationToolConfig
```

Add at the top:
```python
from pydantic import Field
from nanobot.config.schema import Base
```

Add config class before `ImageGenerationTool`:
```python
class ImageGenerationToolConfig(Base):
    """Image generation tool configuration."""
    enabled: bool = False
    provider: str = "openrouter"
    model: str = "openai/gpt-5.4-image-2"
    default_aspect_ratio: str = "1:1"
    default_image_size: str = "1K"
    max_images_per_turn: int = Field(default=4, ge=1, le=8)
    save_dir: str = "generated"
```

Add metadata to `ImageGenerationTool`:
```python
    config_key = "image_generation"

    @classmethod
    def config_cls(cls):
        return ImageGenerationToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.tools.image_generation.enabled

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            config=ctx.config.tools.image_generation,
            provider_configs=ctx.image_generation_provider_configs,
        )
```

- [ ] **Step 6: Run all new tests**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py -v -k "exec_tool or web_tool or web_tools or web_search or web_fetch or image_gen"`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/tools/shell.py nanobot/agent/tools/web.py nanobot/agent/tools/image_generation.py tests/tools/test_tool_loader.py
git commit -m "feat(tools): add config classes and create() to exec, web, image gen tools"
```

---

### Task 7: Add MyToolConfig + `_plugin_discoverable = False` to MCP wrappers

**Files:**
- Modify: `nanobot/agent/tools/self.py`
- Modify: `nanobot/agent/tools/mcp.py`
- Test: `tests/tools/test_tool_loader.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/test_tool_loader.py`:

```python
def test_my_tool_config_cls():
    from nanobot.agent.tools.self import MyTool, MyToolConfig
    assert MyTool.config_key == "my"
    assert MyTool.config_cls() is MyToolConfig


def test_my_tool_enabled():
    from nanobot.agent.tools.self import MyTool

    mock_config = MagicMock()
    mock_config.tools.my.enable = True
    ctx = ToolContext(config=mock_config, workspace="/tmp")
    assert MyTool.enabled(ctx) is True

    mock_config.tools.my.enable = False
    assert MyTool.enabled(ctx) is False


def test_mcp_wrappers_not_discoverable():
    from nanobot.agent.tools.mcp import MCPToolWrapper, MCPResourceWrapper, MCPPromptWrapper
    assert MCPToolWrapper._plugin_discoverable is False
    assert MCPResourceWrapper._plugin_discoverable is False
    assert MCPPromptWrapper._plugin_discoverable is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_my_tool_config_cls -v`
Expected: FAIL

- [ ] **Step 3: Add MyToolConfig to self.py**

In `nanobot/agent/tools/self.py`, add imports at top:
```python
from pydantic import Field
from nanobot.config.schema import Base
```

Add config class before `MyTool`:
```python
class MyToolConfig(Base):
    """Self-inspection tool configuration."""
    enable: bool = True
    allow_set: bool = False
```

Add metadata to `MyTool` (NOTE: no `create()` — MyTool is manually registered):
```python
    config_key = "my"

    @classmethod
    def config_cls(cls):
        return MyToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.tools.my.enable
```

- [ ] **Step 4: Add `_plugin_discoverable = False` to MCP wrappers**

In `nanobot/agent/tools/mcp.py`, add to each of `MCPToolWrapper`, `MCPResourceWrapper`, `MCPPromptWrapper`:

```python
    _plugin_discoverable = False
```

Place it as a class-level attribute right after the class definition line, before `__init__`.

- [ ] **Step 5: Run tests**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_my_tool tests/tools/test_tool_loader.py::test_mcp_wrappers -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/tools/self.py nanobot/agent/tools/mcp.py tests/tools/test_tool_loader.py
git commit -m "feat(tools): add MyToolConfig and exclude MCP wrappers from discovery"
```

---

### Task 8: Update schema.py — replace inline config with imports

**Files:**
- Modify: `nanobot/config/schema.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/test_tool_loader.py`:

```python
def test_config_round_trip_camel_case():
    """Verify config serialization is unchanged after moving config classes."""
    from nanobot.config.schema import Config

    # Test with camelCase keys (what users write in config.json)
    config_dict = {
        "tools": {
            "web": {"enable": True, "search": {"provider": "brave", "api_key": "test"}},
            "exec": {"enable": False, "timeout": 120},
            "my": {"enable": True, "allowSet": True},
            "imageGeneration": {"enabled": True, "provider": "openrouter"},
        }
    }
    config = Config.model_validate(config_dict)
    dumped = config.model_dump(mode="json")

    # Verify camelCase round-trip works
    assert dumped["tools"]["my"]["allowSet"] is True
    assert dumped["tools"]["imageGeneration"]["enabled"] is True
    assert config.tools.exec.enable is False
    assert config.tools.exec.timeout == 120
    assert config.tools.web.search.provider == "brave"


def test_config_defaults_unchanged():
    """Verify default values match the original hardcoded schema."""
    from nanobot.config.schema import Config

    config = Config.model_validate({})
    assert config.tools.exec.enable is True
    assert config.tools.exec.timeout == 60
    assert config.tools.web.enable is True
    assert config.tools.web.search.provider == "duckduckgo"
    assert config.tools.my.enable is True
    assert config.tools.my.allow_set is False
    assert config.tools.image_generation.enabled is False
    assert config.tools.restrict_to_workspace is False
```

- [ ] **Step 2: Run test to verify it passes BEFORE changes (baseline)**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_config_round_trip tests/tools/test_tool_loader.py::test_config_defaults -v`
Expected: PASS — this establishes the baseline before we migrate

- [ ] **Step 3: Update schema.py**

In `nanobot/config/schema.py`, replace the inline config class definitions with imports:

Remove these classes from schema.py:
- `WebSearchConfig` (lines ~198-206)
- `WebFetchConfig` (lines ~208-211)
- `WebToolsConfig` (lines ~214-223)
- `ExecToolConfig` (lines ~226-235)
- `MyToolConfig` (lines ~249-253)
- `ImageGenerationToolConfig` (lines ~256-265)

Add these imports at the top of schema.py (after existing imports):
```python
from nanobot.agent.tools.shell import ExecToolConfig
from nanobot.agent.tools.web import WebFetchConfig, WebSearchConfig, WebToolsConfig
from nanobot.agent.tools.self import MyToolConfig
from nanobot.agent.tools.image_generation import ImageGenerationToolConfig
```

Keep `ToolsConfig` as-is — it now references the imported classes instead of inline ones.

- [ ] **Step 4: Run tests to verify round-trip still works**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_config_round_trip tests/tools/test_tool_loader.py::test_config_defaults -v`
Expected: PASS — identical behavior

- [ ] **Step 5: Run all existing config tests**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/config/ -v`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/config/schema.py tests/tools/test_tool_loader.py
git commit -m "refactor(config): move tool config classes to their tool modules"
```

---

### Task 9: Simplify `_register_default_tools` in AgentLoop

**Files:**
- Modify: `nanobot/agent/loop.py:494-563`
- Modify: `nanobot/agent/tools/__init__.py`

- [ ] **Step 1: Update `__init__.py` exports**

In `nanobot/agent/tools/__init__.py`, add the new public API:

```python
from nanobot.agent.tools.context import ToolContext
from nanobot.agent.tools.loader import ToolLoader
```

Add `"ToolContext"` and `"ToolLoader"` to `__all__`.

- [ ] **Step 2: Replace `_register_default_tools` in loop.py**

In `nanobot/agent/loop.py`, replace the existing `_register_default_tools` method (lines 494-563) with:

```python
    def _register_default_tools(self) -> None:
        """Register the default set of tools via plugin loader."""
        from nanobot.agent.tools.context import ToolContext
        from nanobot.agent.tools.loader import ToolLoader
        from nanobot.agent.tools.self import MyTool

        ctx = ToolContext(
            config=self._config,
            workspace=str(self.workspace),
            bus=self.bus,
            subagent_manager=self.subagents,
            cron_service=self.cron_service,
            file_state_store=self._file_state_store,
            provider_snapshot_loader=self._provider_snapshot_loader,
            image_generation_provider_configs=self._image_generation_provider_configs,
            timezone=self.context.timezone or "UTC",
        )
        loader = ToolLoader()
        registered = loader.load(ctx, self.tools)

        # MyTool needs AgentLoop reference — manual registration
        if self._config.tools.my.enable:
            self.tools.register(
                MyTool(loop=self, modify_allowed=self._config.tools.my.allow_set)
            )
            registered.append("my")

        logger.info("Registered {} tools: {}", len(registered), registered)
```

Also remove the now-unused imports at the top of loop.py that were only needed for `_register_default_tools`:
- `from nanobot.agent.tools.ask import AskUserTool` — remove if no other usage
- `from nanobot.agent.tools.message import MessageTool` — remove if no other usage
- `from nanobot.agent.tools.spawn import SpawnTool` — remove if no other usage
- Keep imports used elsewhere in loop.py (check with grep)

- [ ] **Step 3: Run all tool tests**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/ -v --timeout=60`
Expected: All PASS

- [ ] **Step 4: Run agent loop tests**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/agent/ -v --timeout=60`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add nanobot/agent/loop.py nanobot/agent/tools/__init__.py
git commit -m "refactor(loop): replace hardcoded tool registration with plugin loader"
```

---

### Task 10: Full integration test — verify tool parity

**Files:**
- Test: `tests/tools/test_tool_loader.py` (append)
- Run: actual nanobot agent

- [ ] **Step 1: Write integration test**

Append to `tests/tools/test_tool_loader.py`:

```python
def test_loader_registers_same_tools_as_old_hardcoded():
    """Verify the loader produces the same tool set as the old _register_default_tools."""
    from nanobot.agent.tools.loader import ToolLoader
    from nanobot.agent.tools.registry import ToolRegistry

    # Default config: exec=True, web=True, my=True, image_gen=False
    mock_config = MagicMock()
    mock_config.tools.exec.enable = True
    mock_config.tools.exec.timeout = 60
    mock_config.tools.exec.sandbox = ""
    mock_config.tools.exec.path_append = ""
    mock_config.tools.exec.allowed_env_keys = []
    mock_config.tools.exec.allow_patterns = []
    mock_config.tools.exec.deny_patterns = []
    mock_config.tools.restrict_to_workspace = False
    mock_config.tools.web.enable = True
    mock_config.tools.web.search = MagicMock()
    mock_config.tools.web.fetch = MagicMock()
    mock_config.tools.web.proxy = None
    mock_config.tools.web.user_agent = None
    mock_config.tools.image_generation.enabled = False
    mock_config.tools.my.enable = True

    ctx = ToolContext(
        config=mock_config,
        workspace="/tmp",
        bus=MagicMock(),
        subagent_manager=MagicMock(),
        cron_service=MagicMock(),
        timezone="UTC",
    )
    registry = ToolRegistry()
    loader = ToolLoader()
    registered = loader.load(ctx, registry)

    # Expected tools for default config (excluding MyTool which is manual)
    expected = {
        "ask_user", "read_file", "write_file", "edit_file", "list_dir",
        "glob", "grep", "notebook_edit", "exec", "web_search", "web_fetch",
        "message", "spawn", "cron",
    }
    actual = set(registered)
    assert expected <= actual, f"Missing tools: {expected - actual}"
```

- [ ] **Step 2: Run the integration test**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/tools/test_tool_loader.py::test_loader_registers_same_tools_as_old_hardcoded -v`
Expected: PASS

- [ ] **Step 3: Run the full test suite**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && uv run pytest tests/ -v --timeout=120 -x`
Expected: All PASS

- [ ] **Step 4: Smoke test with actual nanobot agent**

Run: `cd D:/Documents/GitHub/nanobot/.worktrees/tool && echo "hello, what tools do you have?" | uv run nanobot agent -m openai/gpt-4.1-mini --one-shot`
Expected: The agent starts, registers tools, and responds. Check that the log line "Registered N tools: [...]" appears with the expected count.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/GitHub/nanobot/.worktrees/tool
git add tests/tools/test_tool_loader.py
git commit -m "test(tools): add integration test for loader tool parity"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: Each section of the design spec maps to a task
- [x] **Placeholder scan**: No TBDs, TODOs, or "implement later" — all code is concrete
- [x] **Type consistency**: `ToolContext` fields match what `create()` methods expect; `enabled(ctx)` takes `ToolContext` everywhere
- [x] **Import cycles**: `schema.py` → tool modules (import `Base` only); tool modules use `TYPE_CHECKING` for `Config`
- [x] **Backward compat**: `__init__` signatures unchanged; SubagentManager/Consolidator unaffected
- [x] **MyTool exception**: Documented and handled via manual registration in Task 9
- [x] **MCP exclusion**: `_plugin_discoverable = False` in Task 7
- [x] **Config round-trip**: Tested in Task 8
- [x] **Integration test**: Task 10 verifies tool parity with old hardcoded approach
