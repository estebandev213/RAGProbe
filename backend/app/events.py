"""In-memory SSE event bus: per-run fan-out of run progress events (§6.7).

A run is a background ``asyncio.Task`` that publishes :class:`~app.models.RunEvent`
objects as it advances through its phases; the SSE endpoint subscribes and drains
them to the browser. The bus is deliberately in-memory and single-process — fine
for the single-container deployment — and carries only *live* events. A late or
reconnecting subscriber gets the current status replayed from the database by the
route, not by buffering history here.

Each subscriber owns its own ``asyncio.Queue`` so multiple clients can watch the
same run independently. A ``None`` sentinel on the queue marks end-of-stream
(``close``), which lets the consuming generator exit cleanly.
"""

from __future__ import annotations

import asyncio

from app.models import RunEvent

# A queue carries live events and, finally, a ``None`` end-of-stream sentinel.
EventQueue = asyncio.Queue["RunEvent | None"]


class EventBus:
    """Per-run fan-out of :class:`RunEvent`s to any number of subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[EventQueue]] = {}

    def subscribe(self, run_id: str) -> EventQueue:
        """Register and return a new queue receiving ``run_id``'s live events."""
        queue: EventQueue = asyncio.Queue()
        self._subscribers.setdefault(run_id, set()).add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: EventQueue) -> None:
        """Drop a subscriber's queue, removing the run's bucket once empty."""
        queues = self._subscribers.get(run_id)
        if queues is None:
            return
        queues.discard(queue)
        if not queues:
            del self._subscribers[run_id]

    def publish(self, run_id: str, event: RunEvent) -> None:
        """Push ``event`` onto every current subscriber queue for ``run_id``."""
        for queue in self._subscribers.get(run_id, set()):
            queue.put_nowait(event)

    def close(self, run_id: str) -> None:
        """Signal end-of-stream to every subscriber by enqueuing the sentinel."""
        for queue in self._subscribers.get(run_id, set()):
            queue.put_nowait(None)


# Process-wide singleton shared by the runner (publisher) and the route (subscriber).
bus = EventBus()
