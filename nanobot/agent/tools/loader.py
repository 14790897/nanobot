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
    def __init__(self, package: Any = None):
        if package is None:
            import nanobot.agent.tools as _pkg
            package = _pkg
        self._package = package

    def discover(self) -> list[type[Tool]]:
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
