import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app import claude_subprocess as cs


@pytest.mark.asyncio
async def test_run_streaming_yields_stdout_chunks_and_returns_zero():
    fake_proc = MagicMock()
    fake_proc.stdout.readline = AsyncMock(side_effect=[
        b'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}\n',
        b'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world\\n"}}}\n',
        b"",
    ])
    fake_proc.wait = AsyncMock(return_value=0)
    fake_proc.returncode = 0

    with patch("app.claude_subprocess.asyncio.create_subprocess_exec",
               new=AsyncMock(return_value=fake_proc)):
        chunks = [c async for c in cs.run_streaming(["-p", "hello"])]

    assert chunks == ["hello ", "world\n"]


@pytest.mark.asyncio
async def test_run_streaming_raises_when_subprocess_fails():
    fake_proc = MagicMock()
    fake_proc.stdout.readline = AsyncMock(side_effect=[b""])
    fake_proc.wait = AsyncMock(return_value=2)
    fake_proc.returncode = 2
    fake_proc.stderr.read = AsyncMock(return_value=b"boom")

    with patch("app.claude_subprocess.asyncio.create_subprocess_exec",
               new=AsyncMock(return_value=fake_proc)):
        with pytest.raises(cs.ClaudeSubprocessError) as exc:
            async for _ in cs.run_streaming(["-p", "hi"]):
                pass

    assert "boom" in str(exc.value)


@pytest.mark.asyncio
async def test_run_streaming_passes_through_args_and_stdin():
    fake_proc = MagicMock()
    fake_proc.stdout.readline = AsyncMock(side_effect=[b""])
    fake_proc.wait = AsyncMock(return_value=0)
    fake_proc.returncode = 0
    fake_proc.stdin = MagicMock()
    fake_proc.stdin.write = MagicMock()
    fake_proc.stdin.drain = AsyncMock()
    fake_proc.stdin.close = MagicMock()

    spy = AsyncMock(return_value=fake_proc)
    with patch("app.claude_subprocess.asyncio.create_subprocess_exec", new=spy):
        async for _ in cs.run_streaming(["--model", "opus", "-p", "summarize"], stdin_text="PROMPT"):
            pass

    args, kwargs = spy.call_args
    assert args[0] == "claude"
    assert "--model" in args
    assert "opus" in args
    fake_proc.stdin.write.assert_called_once_with(b"PROMPT")


@pytest.mark.asyncio
async def test_concurrency_semaphore_caps_at_four():
    assert cs._SEMAPHORE._value == 4
