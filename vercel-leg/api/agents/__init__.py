"""
Specialist swarm agents (Level 4).

Each agent module follows the same contract:
    AGENT_TYPE : str            -- stable identifier stored in tasks.agent_type
    run(telegram_id, task_input, task_id=None, context=None) -> dict

Return dict contract:
    {"success": bool, "result": str, "error": str, "tool_names": [str]}

Agents are independently testable: run() calls only public helpers.
All I/O is synchronous (see api/swarm_coordinator.py for the rationale).
"""