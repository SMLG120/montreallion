"""Mirror of src/lib/game/scoring.ts (estimated-v1) for previews in the review report."""


def score(est: int, max_est: int) -> int:
    return max(10, min(100, round(100 - 90 * est / max_est)))
