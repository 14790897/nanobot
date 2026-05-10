# Tool Plugin Architecture Design

## Problem

`AgentLoop._register_default_tools()` (loop.py:494) hardcodes 14 tool registrations with
varying enable conditions and constructor signatures. Adding a new tool requires editing this
method and often `ToolsConfig` in schema.py. The tool system is closed for extension — MCP is
the only dynamic path.

## Goals

1. **Internal decoupling**: Each tool is self-describing — it declares its own config class,
   enable condition, and factory method. `_register_default_tools` shrinks to a 3-line loader call.
2. **Tool self-description**: No central registry of "which tools exist" or "what config they need."
   The loader discovers tools by scanning the package.
3. **Config co-location**: Each tool's Pydantic config class lives alongside the tool implementation,
   not in a monolithic `schema.py`.
4. **No third-party entry_points**: MCP remains the official extension path. This redesign is
   purely for internal maintainability.
5. **Full backward compatibility**: User `config.json` unchanged. JSON field names and structure
   identical.

## Non-goals

- Third-party Python plugin API (entry_points, pip-installable tool packages)
- Changes to `ToolRegistry` (the in-memory dict container stays as-is)
- Changes to MCP tool integration
- Changes to SubagentManager or Consolidator's manual registration (they keep direct `__init__` calls)

## Design Decisions

### DD-1: Tool `__init__` signatures are NOT changed

Tool constructors keep their current signatures. `create()` is an **alternative factory** that
calls `__init__` internally. SubagentManager and Consolidator continue to call `__init__` directly.
This means:
- Zero changes to subagent/dream code paths
- `create()` simply encapsulates the wiring that currently lives in `_register_default_tools`

### DD-2: MyTool is registered outside the loader

`MyTool` requires a direct reference to `AgentLoop`, which fundamentally conflicts with the
factory pattern. It stays as a manual registration after `loader.load()` in `_register_default_tools()`.
This is a documented exception, not a design hole — `MyTool` is an introspection/debug tool that
is tightly coupled to the loop by nature.

### DD-3: Config classes use `Base` from schema.py, not bare `BaseModel`

Tool config classes must extend `Base` (which sets `alias_generator=to_camel,
populate_by_name=True`) to preserve camelCase JSON compatibility. To avoid circular imports,
config classes import `Base` directly from `nanobot.config.schema` — this is safe because
`Base` has no dependency on tool code.

---

## Architecture

### 1. Tool ABC Enhancement

Add class-level metadata to `Tool` (base.py). Existing `__init__` signatures and abstract methods
remain unchanged:

```python
class Tool(ABC):
    # --- Existing (unchanged) ---
    # name, description, parameters, execute, read_only, concurrency_safe, exclusive
    # cast_params, validate_params, to_schema — all unchanged

    # --- New class-level metadata ---

    config_key: str = ""
    """Key under ToolsConfig where this tool's config lives. Empty = no config."""

    _plugin_discoverable: bool = True
    """Set False on classes that should not be auto-discovered (e.g. MCP wrappers)."""

    @classmethod
    def config_cls(cls) -> type[BaseModel] | None:
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

Key changes from initial design:
- `enabled()` takes `ToolContext` (not just `ToolsConfig`) so CronTool can check `ctx.cron_service`
- `_plugin_discoverable` flag excludes MCP wrappers from discovery
- `create()` calls `cls()` by default — does NOT replace `__init__`

### 2. ToolContext

```python
# nanobot/agent/tools/context.py

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from pathlib import Path

    from nanobot.agent.cron import CronService
    from nanobot.agent.subagent import SubagentManager
    from nanobot.agent.tools.file_state import FileStateStore
    from nanobot.bus.queue import MessageBus
    from nanobot.config.schema import Config


@dataclass
class ToolContext:
    config: Config
    workspace: str
    bus: MessageBus | None = None
    subagent_manager: SubagentManager | None = None
    cron_service: CronService | None = None
    file_state_store: FileStateStore = field(default_factory=FileStateStore)
    provider_snapshot_loader: Callable[[], Any] | None = None
    image_generation_provider_configs: dict[str, Any] | None = None
    timezone: str = "UTC"
```

Fields derived from review:
- `provider_snapshot_loader` — needed by WebSearchTool to build its config_loader closure
- `image_generation_provider_configs` — needed by ImageGenerationTool
- `timezone` — needed by CronTool (from `context.timezone` on the loop)

### 3. ToolLoader

```python
# nanobot/agent/tools/loader.py

import importlib
import logging
import pkgutil
from typing import Any

from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.context import ToolContext
from nanobot.agent.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

# Modules that contain tool infrastructure, not discoverable tools
_SKIP_MODULES = frozenset({"base", "schema", "registry", "context", "loader", "config",
                            "file_state", "sandbox", "mcp", "__init__"})


class ToolLoader:
    """Scan nanobot/agent/tools/, discover Tool subclasses, register enabled ones."""

    def __init__(self, package: Any = None):
        if package is None:
            import nanobot.agent.tools as _pkg
            package = _pkg
        self._package = package

    def discover(self) -> list[type[Tool]]:
        """Return all concrete, discoverable Tool subclasses, sorted by name."""
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

    def load(self, ctx: ToolContext, registry: ToolRegistry) -> list[str]:
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

**Discovery rules**:
- Skip modules in `_SKIP_MODULES` (infrastructure: base, schema, registry, mcp, etc.)
- Skip modules starting with `_`
- Skip abstract Tool subclasses (those with `__abstractmethods__`)
- Skip private class names (starting with `_`)
- Skip classes with `_plugin_discoverable = False` (MCP wrappers)
- Sort by class name for deterministic ordering
- Warn on tool name collisions

### 4. Config Co-location

Each tool that needs configuration defines its Pydantic config class in its own module.
Config classes extend `Base` from `nanobot.config.schema` (for camelCase alias support):

```python
# nanobot/agent/tools/shell.py

from nanobot.config.schema import Base  # Safe: Base has no tool dependency

class ExecToolConfig(Base):
    enable: bool = True
    timeout: int = 60
    path_append: str = ""
    sandbox: str = ""
    allowed_env_keys: list[str] = Field(default_factory=list)
    allow_patterns: list[str] = Field(default_factory=list)
    deny_patterns: list[str] = Field(default_factory=list)

class ExecTool(Tool):
    config_key = "exec"

    @classmethod
    def config_cls(cls):
        return ExecToolConfig

    @classmethod
    def enabled(cls, ctx):
        return ctx.config.tools.exec.enable

    @classmethod
    def create(cls, ctx):
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

### 5. ToolsConfig — Static, Not Dynamic

**Revised approach**: Rather than `create_model` dynamic construction (which risks import cycles,
loses IDE support, and complicates testing), `ToolsConfig` stays as a static Pydantic model in
`schema.py`. The config classes are imported from their new locations:

```python
# nanobot/config/schema.py (revised)

# Config classes now live alongside their tools; schema.py re-exports them
from nanobot.agent.tools.shell import ExecToolConfig
from nanobot.agent.tools.web import WebToolsConfig
from nanobot.agent.tools.self import MyToolConfig
from nanobot.agent.tools.image_generation import ImageGenerationToolConfig

class ToolsConfig(Base):
    """Tools configuration."""
    web: WebToolsConfig = Field(default_factory=WebToolsConfig)
    exec: ExecToolConfig = Field(default_factory=ExecToolConfig)
    my: MyToolConfig = Field(default_factory=MyToolConfig)
    image_generation: ImageGenerationToolConfig = Field(default_factory=ImageGenerationToolConfig)
    restrict_to_workspace: bool = False
    mcp_servers: dict[str, MCPServerConfig] = Field(default_factory=dict)
    ssrf_whitelist: list[str] = Field(default_factory=list)
```

**Why not dynamic**: The review identified critical issues with `create_model`:
1. Import cycles (tools import schema → schema imports tools/config → config imports tools)
2. `create_model` with `__base__=BaseModel` loses camelCase alias support
3. No IDE autocompletion for dynamically generated fields
4. Unnecessary complexity for a set of tools that changes rarely

**Trade-off**: Adding a new tool with config requires adding one line to `ToolsConfig`. This is
a minor manual step compared to the full dynamic approach, but avoids all the risks.

### 6. Import Cycle Prevention

The config migration creates a potential cycle: `schema.py` imports tool modules → tool modules
import from `schema.py`. Prevention strategy:

1. **Tool modules only import `Base` from schema.py** — `Base` is a simple Pydantic `BaseModel`
   subclass with no tool dependencies. This never causes a cycle.
2. **Tool modules use `TYPE_CHECKING` guards** for any other schema imports (e.g. `Config`,
   `ProviderConfig`). Runtime references go inside method bodies.
3. **`loader.py` and `context.py` use `TYPE_CHECKING`** for all schema types.

```
schema.py --imports--> tool modules (Base only)
tool modules --imports--> schema.py (Base, TYPE_CHECKING for Config)
loader.py --TYPE_CHECKING--> schema.py (Config)
```

This is a one-way dependency at runtime: schema.py → tool modules. No cycle possible.

### 7. AgentLoop Simplification

`_register_default_tools()` shrinks from ~50 lines to:

```python
def _register_default_tools(self) -> None:
    from nanobot.agent.tools.context import ToolContext
    from nanobot.agent.tools.loader import ToolLoader

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

    # MyTool needs AgentLoop reference — cannot use factory pattern
    if self._config.tools.my.enable:
        self.tools.register(MyTool(loop=self, modify_allowed=self._config.tools.my.allow_set))

    logger.info("Registered %d tools: %s", len(registered) + (1 if self.tools.has("my") else 0),
                self.tools.tool_names)
```

### 8. FileSystem Tools — FileStates Resolution

`_FsTool.__init__` takes optional `file_states: FileStates | None`. In the main loop, this is
left as `None` and the tool resolves per-session state via contextvars (`current_file_states()`).
The `create()` override does NOT pass `file_states`:

```python
class ReadFileTool(_FsTool):
    @classmethod
    def create(cls, ctx):
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

SubagentManager and Consolidator continue to pass explicit `FileStates()` for isolation,
bypassing `create()` entirely.

---

## File Changes Summary

| File | Change |
|---|---|
| `nanobot/agent/tools/base.py` | Add `config_key`, `_plugin_discoverable`, `config_cls()`, `enabled(ctx)`, `create(ctx)` |
| `nanobot/agent/tools/context.py` | **New**: `ToolContext` dataclass |
| `nanobot/agent/tools/loader.py` | **New**: `ToolLoader` class with `_SKIP_MODULES` |
| `nanobot/agent/tools/shell.py` | Move `ExecToolConfig` here from schema.py; add metadata overrides |
| `nanobot/agent/tools/web.py` | Move `WebToolsConfig`/`WebSearchConfig`/`WebFetchConfig` here; add overrides |
| `nanobot/agent/tools/self.py` | Move `MyToolConfig` here; add `enabled()` override (no `create` — uses manual reg) |
| `nanobot/agent/tools/image_generation.py` | Move `ImageGenerationToolConfig` here; add overrides |
| `nanobot/agent/tools/ask.py` | No changes needed (default `create()` works) |
| `nanobot/agent/tools/filesystem.py` | Add `create()` overrides for ReadFileTool, WriteFileTool, EditFileTool, ListDirTool |
| `nanobot/agent/tools/search.py` | Add `create()` overrides for GlobTool, GrepTool |
| `nanobot/agent/tools/notebook.py` | Add `create()` override |
| `nanobot/agent/tools/message.py` | Add `create()` override |
| `nanobot/agent/tools/spawn.py` | Add `create()` override |
| `nanobot/agent/tools/cron.py` | Add `create()` + `enabled(ctx)` override |
| `nanobot/agent/tools/mcp.py` | Add `_plugin_discoverable = False` to MCP wrapper classes |
| `nanobot/config/schema.py` | Replace inline config classes with imports from tool modules; keep `ToolsConfig` static |
| `nanobot/agent/loop.py` | Simplify `_register_default_tools()` |
| `nanobot/agent/tools/__init__.py` | Export new public API |

## Tool-by-tool Migration Map

| Tool | config_key | config_cls | enabled | create() needs |
|---|---|---|---|---|
| AskUserTool | "" | None | always | — (default `cls()`) |
| ReadFileTool | "" | None | always | workspace, allowed_dir, extra_allowed_dirs |
| WriteFileTool | "" | None | always | workspace, allowed_dir |
| EditFileTool | "" | None | always | workspace, allowed_dir |
| ListDirTool | "" | None | always | workspace, allowed_dir |
| GlobTool | "" | None | always | workspace, allowed_dir |
| GrepTool | "" | None | always | workspace, allowed_dir |
| NotebookEditTool | "" | None | always | workspace, allowed_dir |
| ExecTool | "exec" | ExecToolConfig | ctx.config.tools.exec.enable | workspace + exec config fields |
| WebSearchTool | "web" | WebToolsConfig | ctx.config.tools.web.enable | web config + proxy + snapshot_loader |
| WebFetchTool | "web" | (shared) | ctx.config.tools.web.enable | web fetch config + proxy |
| ImageGenerationTool | "image_generation" | ImageGenerationToolConfig | ctx.config.tools.image_generation.enabled | workspace + config + provider_configs |
| MessageTool | "" | None | always | bus.send_callback + workspace |
| SpawnTool | "" | None | always | subagent_manager |
| CronTool | "" | None | ctx.cron_service is not None | cron_service + timezone |
| MyTool | "my" | MyToolConfig | ctx.config.tools.my.enable | **Manual registration** (needs AgentLoop) |

## Edge Cases

1. **Shared config_key**: WebSearchTool and WebFetchTool both declare `config_key = "web"` with
   the same `WebToolsConfig`. Since `ToolsConfig` is static, this is handled naturally — both
   tools read from `config.tools.web`.
2. **CronTool conditional**: `enabled()` checks `ctx.cron_service is not None`.
3. **Tool ordering**: `get_definitions()` in ToolRegistry sorts by name; loader registration
   order does not affect final API output.
4. **Abstract base classes**: `_FsTool`, `_SearchTool` have `__abstractmethods__` and are
   automatically skipped.
5. **MCP wrappers**: `MCPToolWrapper`, `MCPResourceWrapper`, `MCPPromptWrapper` set
   `_plugin_discoverable = False` and are excluded from discovery.
6. **MyTool exception**: Requires `AgentLoop` reference. Registered manually after `loader.load()`.
7. **WebSearchTool config_loader**: The `create()` override constructs the config_loader closure
   from `ctx.provider_snapshot_loader` if present.

## Test Plan

1. **Config round-trip**: Verify `Config.model_validate(old_config_dict)` and
   `Config.model_dump(mode="json")` produce identical results after migration.
2. **Tool discovery**: Mock the package and verify exactly the expected tools are found;
   verify MCP wrappers and abstract classes are excluded.
3. **Tool registration parity**: Verify `loader.load()` produces the same tool set as the old
   `_register_default_tools()` for a given config.
4. **Import order**: Test that importing `schema.py` does not trigger heavy tool module imports
   (only config class imports, which are lightweight).
5. **Subagent isolation**: Verify subagent still gets its own `FileStates` via direct `__init__`.
6. **Integration test**: Run `nanobot agent` and verify all tools work end-to-end.
