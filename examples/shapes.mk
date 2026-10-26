// Enums, exhaustive match, nested patterns and Result with `?`.

enum Shape {
    Circle(radius: float)
    Rect(w: float, h: float)
    Empty
}

fn area(s: Shape) -> float {
    return match s {
        Circle(r) => 3.14159 * r * r
        Rect(w, h) => w * h
        Empty => 0.0
    }
}

fn describe(s: Shape) -> string {
    return match s {
        Circle(r) if r > 10.0 => "a big circle"
        Circle(_) => "a circle"
        Rect(w, h) if w == h => "a square"
        Rect(_, _) => "a rectangle"
        Empty => "nothing"
    }
}

enum ParseError {
    EmptyInput
    Negative(value: int)
}

fn parseRadius(text: string) -> Result<float, ParseError> {
    if text == "" { return Err(EmptyInput) }
    let n = int(text)
    if n < 0 { return Err(Negative(n)) }
    return Ok(float(n))
}

fn circleArea(text: string) -> Result<float, ParseError> {
    let r = parseRadius(text)?
    return Ok(area(Circle(r)))
}

fn main() {
    let shapes = [Circle(1.0), Circle(20.0), Rect(2.0, 2.0), Rect(2.0, 5.0), Empty]
    for s in shapes {
        print(describe(s), "→", area(s))
    }
    print("total area:", shapes |> map(area) |> sum)

    for input in ["3", "", "-4"] {
        match circleArea(input) {
            Ok(a) => print("area for", input, "=", a)
            Err(EmptyInput) => print("no input")
            Err(Negative(v)) => print("negative radius:", v)
        }
    }
}

test "areas" {
    assert area(Rect(2.0, 5.0)) == 10.0
    assert area(Empty) == 0.0
}

test "errors propagate through ?" {
    assert circleArea("-1") == Err(Negative(-1))
    assert circleArea("") == Err(EmptyInput)
}
