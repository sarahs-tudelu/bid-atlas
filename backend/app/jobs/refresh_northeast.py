"""Compatibility entry point for deployments that still reference the old job name."""

from .refresh_national import handler


__all__ = ["handler"]
