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
    config: Any
    workspace: str
    bus: Any | None = None
    subagent_manager: Any | None = None
    cron_service: Any | None = None
    file_state_store: Any = field(default=None)
    provider_snapshot_loader: Callable[[], Any] | None = None
    image_generation_provider_configs: dict[str, Any] | None = None
    timezone: str = "UTC"
