export fn average(values: List<int>) -> float {
    if len(values) == 0 {
        return 0.0
    }
    var total = 0
    for v in values {
        total += v
    }
    return total / len(values)
}

export fn clamp(value: int, lo: int, hi: int) -> int {
    if value < lo { return lo }
    if value > hi { return hi }
    return value
}
