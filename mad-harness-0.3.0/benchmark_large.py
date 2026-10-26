"""
A larger, more complex Python file for benchmarking the MAD Harness AST Pruner.
Simulates a real-world FastAPI microservice with multiple patterns.
"""

import os
import sys
import json
import hashlib
import logging
from typing import (
    List, Dict, Optional, Tuple, Any,
    Union, Set, Callable, TypeVar, Generic
)
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from functools import wraps, lru_cache
from contextlib import asynccontextmanager

# ─── Logger ──────────────────────────────────────────────────────────────────

logger = logging.getLogger(__name__)

# ─── Constants ───────────────────────────────────────────────────────────────

MAX_BATCH_SIZE = 1000
DEFAULT_PAGE_SIZE = 50
RATE_LIMIT_WINDOW = 60  # seconds
MAX_REQUESTS_PER_WINDOW = 100
CACHE_TTL_SECONDS = 300
API_VERSION: str = "3.0.0"
SUPPORTED_LANGUAGES: List[str] = ["python", "typescript", "rust", "go"]
ERROR_CODES: Dict[str, int] = {
    "NOT_FOUND": 404,
    "BAD_REQUEST": 400,
    "UNAUTHORIZED": 401,
    "RATE_LIMITED": 429,
    "INTERNAL_ERROR": 500,
}

T = TypeVar('T')

# ─── Enums ───────────────────────────────────────────────────────────────────

class TaskStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    RETRYING = "retrying"


class Priority(Enum):
    LOW = 1
    MEDIUM = 5
    HIGH = 10
    CRITICAL = 20


# ─── Decorators ──────────────────────────────────────────────────────────────

def retry(max_attempts: int = 3, backoff_factor: float = 1.5):
    """Decorator that retries a function on failure with exponential backoff."""
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            last_exception = None
            for attempt in range(max_attempts):
                try:
                    return await func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    wait_time = backoff_factor ** attempt
                    logger.warning(
                        f"Attempt {attempt + 1}/{max_attempts} failed for {func.__name__}: {e}. "
                        f"Retrying in {wait_time:.1f}s"
                    )
                    await __import__('asyncio').sleep(wait_time)
            raise last_exception
        return wrapper
    return decorator


def validate_schema(schema: Dict[str, type]):
    """Decorator that validates function inputs against a schema."""
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs):
            if args and isinstance(args[0], dict):
                data = args[0]
                for key, expected_type in schema.items():
                    if key not in data:
                        raise ValueError(f"Missing required field: {key}")
                    if not isinstance(data[key], expected_type):
                        raise TypeError(
                            f"Field '{key}' expected {expected_type.__name__}, "
                            f"got {type(data[key]).__name__}"
                        )
            return func(*args, **kwargs)
        return wrapper
    return decorator


def measure_time(func: Callable) -> Callable:
    """Decorator that measures and logs execution time."""
    @wraps(func)
    async def wrapper(*args, **kwargs):
        start = datetime.now()
        try:
            result = await func(*args, **kwargs)
            duration = (datetime.now() - start).total_seconds()
            logger.info(f"{func.__name__} completed in {duration:.3f}s")
            return result
        except Exception as e:
            duration = (datetime.now() - start).total_seconds()
            logger.error(f"{func.__name__} failed after {duration:.3f}s: {e}")
            raise
    return wrapper


# ─── Data Models ─────────────────────────────────────────────────────────────

@dataclass
class User:
    """Represents a system user."""
    id: str
    email: str
    name: str
    role: str = "user"
    created_at: datetime = field(default_factory=datetime.now)
    is_active: bool = True
    metadata: Dict[str, Any] = field(default_factory=dict)

    def has_permission(self, permission: str) -> bool:
        """Check if user has a specific permission."""
        role_permissions = {
            "admin": {"read", "write", "delete", "manage"},
            "editor": {"read", "write"},
            "viewer": {"read"},
            "user": {"read"},
        }
        allowed = role_permissions.get(self.role, set())
        return permission in allowed

    def to_dict(self) -> Dict[str, Any]:
        """Serialize user to dictionary."""
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "created_at": self.created_at.isoformat(),
            "is_active": self.is_active,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'User':
        """Deserialize user from dictionary."""
        data = dict(data)
        if 'created_at' in data and isinstance(data['created_at'], str):
            data['created_at'] = datetime.fromisoformat(data['created_at'])
        return cls(**data)


@dataclass
class Task:
    """Represents a pipeline task."""
    id: str
    name: str
    description: str
    status: TaskStatus = TaskStatus.PENDING
    priority: Priority = Priority.MEDIUM
    created_by: Optional[str] = None
    assigned_to: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    retry_count: int = 0
    max_retries: int = 3
    dependencies: List[str] = field(default_factory=list)
    tags: Set[str] = field(default_factory=set)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

    @property
    def is_terminal(self) -> bool:
        """Check if task is in a terminal state."""
        return self.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED)

    @property
    def duration(self) -> Optional[timedelta]:
        """Calculate task duration."""
        if self.completed_at and self.created_at:
            return self.completed_at - self.created_at
        return None

    def can_retry(self) -> bool:
        """Check if task can be retried."""
        return (
            self.status == TaskStatus.FAILED
            and self.retry_count < self.max_retries
        )

    def transition(self, new_status: TaskStatus) -> None:
        """Transition task to a new status with validation."""
        valid_transitions = {
            TaskStatus.PENDING: {TaskStatus.RUNNING, TaskStatus.CANCELLED},
            TaskStatus.RUNNING: {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED},
            TaskStatus.FAILED: {TaskStatus.RETRYING, TaskStatus.CANCELLED},
            TaskStatus.RETRYING: {TaskStatus.RUNNING},
            TaskStatus.COMPLETED: set(),
            TaskStatus.CANCELLED: set(),
        }
        allowed = valid_transitions.get(self.status, set())
        if new_status not in allowed:
            raise ValueError(
                f"Invalid transition: {self.status.value} -> {new_status.value}. "
                f"Allowed: {[s.value for s in allowed]}"
            )
        self.status = new_status
        self.updated_at = datetime.now()
        if new_status == TaskStatus.COMPLETED:
            self.completed_at = datetime.now()

    def to_dict(self) -> Dict[str, Any]:
        """Serialize task to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "status": self.status.value,
            "priority": self.priority.value,
            "created_by": self.created_by,
            "assigned_to": self.assigned_to,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "dependencies": self.dependencies,
            "tags": list(self.tags),
            "result": self.result,
            "error": self.error,
        }


# ─── Generic Cache ───────────────────────────────────────────────────────────

class LRUCache(Generic[T]):
    """Thread-safe LRU cache with TTL support."""

    def __init__(self, max_size: int = 1000, ttl_seconds: int = CACHE_TTL_SECONDS):
        self._max_size = max_size
        self._ttl = timedelta(seconds=ttl_seconds)
        self._cache: Dict[str, Tuple[T, datetime]] = {}
        self._access_order: List[str] = []
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> Optional[T]:
        """Get a value from cache, returns None if expired or missing."""
        if key in self._cache:
            value, timestamp = self._cache[key]
            if datetime.now() - timestamp < self._ttl:
                self._hits += 1
                # Move to end of access order
                self._access_order.remove(key)
                self._access_order.append(key)
                return value
            else:
                # Expired
                del self._cache[key]
                self._access_order.remove(key)
        self._misses += 1
        return None

    def set(self, key: str, value: T) -> None:
        """Set a value in the cache."""
        if key in self._cache:
            self._access_order.remove(key)
        elif len(self._cache) >= self._max_size:
            # Evict least recently used
            oldest_key = self._access_order.pop(0)
            del self._cache[oldest_key]

        self._cache[key] = (value, datetime.now())
        self._access_order.append(key)

    def delete(self, key: str) -> bool:
        """Delete a key from cache. Returns True if key existed."""
        if key in self._cache:
            del self._cache[key]
            self._access_order.remove(key)
            return True
        return False

    def clear(self) -> None:
        """Clear all cache entries."""
        self._cache.clear()
        self._access_order.clear()
        self._hits = 0
        self._misses = 0

    @property
    def size(self) -> int:
        """Current number of entries."""
        return len(self._cache)

    @property
    def hit_rate(self) -> float:
        """Cache hit rate as a percentage."""
        total = self._hits + self._misses
        return (self._hits / total * 100) if total > 0 else 0.0

    def stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        return {
            "size": self.size,
            "max_size": self._max_size,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": f"{self.hit_rate:.1f}%",
            "ttl_seconds": self._ttl.total_seconds(),
        }


# ─── Rate Limiter ────────────────────────────────────────────────────────────

class RateLimiter:
    """Token bucket rate limiter."""

    def __init__(
        self,
        max_requests: int = MAX_REQUESTS_PER_WINDOW,
        window_seconds: int = RATE_LIMIT_WINDOW
    ):
        self._max_requests = max_requests
        self._window = timedelta(seconds=window_seconds)
        self._requests: Dict[str, List[datetime]] = {}

    def is_allowed(self, client_id: str) -> bool:
        """Check if a request from client_id is allowed."""
        now = datetime.now()
        if client_id not in self._requests:
            self._requests[client_id] = []

        # Clean old entries
        cutoff = now - self._window
        self._requests[client_id] = [
            ts for ts in self._requests[client_id] if ts > cutoff
        ]

        if len(self._requests[client_id]) >= self._max_requests:
            return False

        self._requests[client_id].append(now)
        return True

    def remaining(self, client_id: str) -> int:
        """Get remaining requests for a client."""
        now = datetime.now()
        cutoff = now - self._window
        if client_id not in self._requests:
            return self._max_requests

        recent = [ts for ts in self._requests[client_id] if ts > cutoff]
        return max(0, self._max_requests - len(recent))

    def reset_time(self, client_id: str) -> Optional[datetime]:
        """Get the time when the rate limit resets for a client."""
        if client_id in self._requests and self._requests[client_id]:
            oldest = min(self._requests[client_id])
            return oldest + self._window
        return None


# ─── Pipeline Engine ─────────────────────────────────────────────────────────

class PipelineEngine:
    """Executes a DAG of tasks with dependency resolution."""

    def __init__(self, max_concurrency: int = 4):
        self._max_concurrency = max_concurrency
        self._tasks: Dict[str, Task] = {}
        self._cache = LRUCache[Dict[str, Any]](max_size=500)
        self._rate_limiter = RateLimiter()
        self._event_handlers: Dict[str, List[Callable]] = {}

    def add_task(self, task: Task) -> None:
        """Add a task to the pipeline."""
        if task.id in self._tasks:
            raise ValueError(f"Task {task.id} already exists")
        # Validate dependencies exist
        for dep_id in task.dependencies:
            if dep_id not in self._tasks:
                raise ValueError(f"Dependency {dep_id} not found for task {task.id}")
        self._tasks[task.id] = task

    def remove_task(self, task_id: str) -> None:
        """Remove a task from the pipeline."""
        if task_id not in self._tasks:
            raise ValueError(f"Task {task_id} not found")
        # Check no other tasks depend on this one
        for other in self._tasks.values():
            if task_id in other.dependencies:
                raise ValueError(
                    f"Cannot remove task {task_id}: task {other.id} depends on it"
                )
        del self._tasks[task_id]

    def get_ready_tasks(self) -> List[Task]:
        """Get tasks whose dependencies are all satisfied."""
        ready = []
        for task in self._tasks.values():
            if task.status != TaskStatus.PENDING:
                continue
            deps_satisfied = all(
                self._tasks[dep_id].status == TaskStatus.COMPLETED
                for dep_id in task.dependencies
            )
            if deps_satisfied:
                ready.append(task)
        return sorted(ready, key=lambda t: t.priority.value, reverse=True)

    @measure_time
    async def execute_task(self, task: Task) -> Dict[str, Any]:
        """Execute a single task."""
        task.transition(TaskStatus.RUNNING)
        self._emit_event("task_started", task)

        try:
            # Simulate task execution
            import asyncio
            await asyncio.sleep(0.1)  # Simulated work

            result = {
                "task_id": task.id,
                "output": f"Task {task.name} completed successfully",
                "metrics": {
                    "processed_items": 42,
                    "errors": 0,
                },
            }
            task.result = result
            task.transition(TaskStatus.COMPLETED)
            self._emit_event("task_completed", task)
            return result

        except Exception as e:
            task.error = str(e)
            task.transition(TaskStatus.FAILED)
            self._emit_event("task_failed", task)

            if task.can_retry():
                task.retry_count += 1
                task.transition(TaskStatus.RETRYING)
                task.transition(TaskStatus.RUNNING)
                return await self.execute_task(task)
            raise

    async def run(self) -> Dict[str, Any]:
        """Execute the entire pipeline."""
        import asyncio
        results: Dict[str, Any] = {}
        start_time = datetime.now()

        while True:
            ready_tasks = self.get_ready_tasks()
            if not ready_tasks:
                # Check if there are still running tasks
                running = [t for t in self._tasks.values() if t.status == TaskStatus.RUNNING]
                if not running:
                    break
                await asyncio.sleep(0.05)
                continue

            # Execute ready tasks with concurrency limit
            batch = ready_tasks[:self._max_concurrency]
            task_results = await asyncio.gather(
                *[self.execute_task(t) for t in batch],
                return_exceptions=True
            )

            for task, result in zip(batch, task_results):
                if isinstance(result, Exception):
                    results[task.id] = {"error": str(result)}
                else:
                    results[task.id] = result

        duration = (datetime.now() - start_time).total_seconds()
        return {
            "results": results,
            "total_tasks": len(self._tasks),
            "completed": sum(1 for t in self._tasks.values() if t.status == TaskStatus.COMPLETED),
            "failed": sum(1 for t in self._tasks.values() if t.status == TaskStatus.FAILED),
            "duration_seconds": duration,
            "cache_stats": self._cache.stats(),
        }

    def on(self, event: str, handler: Callable) -> None:
        """Register an event handler."""
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def _emit_event(self, event: str, task: Task) -> None:
        """Emit an event to all registered handlers."""
        for handler in self._event_handlers.get(event, []):
            try:
                handler(task)
            except Exception as e:
                logger.error(f"Error in event handler for {event}: {e}")

    def get_status_summary(self) -> Dict[str, int]:
        """Get a summary of task statuses."""
        summary: Dict[str, int] = {}
        for task in self._tasks.values():
            status = task.status.value
            summary[status] = summary.get(status, 0) + 1
        return summary


# ─── Utility Functions ──────────────────────────────────────────────────────

def generate_id(prefix: str = "") -> str:
    """Generate a unique ID with optional prefix."""
    import uuid
    unique = str(uuid.uuid4())[:8]
    return f"{prefix}_{unique}" if prefix else unique


def hash_content(content: str, algorithm: str = "sha256") -> str:
    """Hash content using specified algorithm."""
    hasher = hashlib.new(algorithm)
    hasher.update(content.encode('utf-8'))
    return hasher.hexdigest()


@lru_cache(maxsize=128)
def parse_duration(duration_str: str) -> timedelta:
    """Parse a duration string like '1h30m' or '45s' into timedelta."""
    import re
    pattern = r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?'
    match = re.match(pattern, duration_str)
    if not match or not any(match.groups()):
        raise ValueError(f"Invalid duration format: {duration_str}")
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    return timedelta(hours=hours, minutes=minutes, seconds=seconds)


def format_bytes(num_bytes: int) -> str:
    """Format bytes into human-readable string."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} PB"


def deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """Deep merge two dictionaries."""
    result = dict(base)
    for key, value in override.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def chunk_list(items: List[Any], chunk_size: int = MAX_BATCH_SIZE) -> List[List[Any]]:
    """Split a list into chunks of specified size."""
    return [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]


async def parallel_map(
    func: Callable,
    items: List[Any],
    max_concurrency: int = 10
) -> List[Any]:
    """Apply a function to items in parallel with concurrency limit."""
    import asyncio
    semaphore = asyncio.Semaphore(max_concurrency)

    async def bounded_func(item):
        async with semaphore:
            return await func(item)

    return await asyncio.gather(*[bounded_func(item) for item in items])


# ─── Main ────────────────────────────────────────────────────────────────────

async def main() -> None:
    """Main entry point for the pipeline service."""
    logging.basicConfig(level=logging.INFO)
    logger.info(f"Starting Pipeline Service v{API_VERSION}")

    engine = PipelineEngine(max_concurrency=4)

    # Create sample tasks
    task1 = Task(id="t1", name="Extract", description="Extract data from source")
    task2 = Task(id="t2", name="Transform", description="Transform data", dependencies=["t1"])
    task3 = Task(id="t3", name="Validate", description="Validate results", dependencies=["t2"])
    task4 = Task(id="t4", name="Load", description="Load into target", dependencies=["t3"])

    for task in [task1, task2, task3, task4]:
        engine.add_task(task)

    engine.on("task_completed", lambda t: logger.info(f"✓ {t.name} completed"))
    engine.on("task_failed", lambda t: logger.error(f"✗ {t.name} failed: {t.error}"))

    result = await engine.run()
    logger.info(f"Pipeline finished: {result['completed']}/{result['total_tasks']} tasks completed")
    logger.info(f"Duration: {result['duration_seconds']:.2f}s")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
