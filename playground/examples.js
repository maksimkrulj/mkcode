// Example programs for the playground. The demo database (when enabled) preloads `User` rows.
export const EXAMPLES = [
  {
    id: "canonical",
    title: "The canonical example",
    code: `// Signal Reactive Primitives
signal score = 100
signal doubleScore = score * 2

// Native Database Query & Implicit Async
fn getActiveUsers(minScore: int) -> List<User> {
    let users = query User where score >= minScore order by score desc
    return users
}

// Linear Ownership
fn processData(consume payload: Buffer) {
    print("Processing buffer...")
}

// Entrypoint
fn main() {
    let buf = Buffer.alloc(1024)
    processData(consume buf)

    // Fetching users implicitly without async/await keywords
    let topUsers = getActiveUsers(50)
    print("Top Users:", topUsers)
}
`,
  },
  {
    id: "view",
    title: "UI: Counter view (Preview tab)",
    code: `// Views are components. {expressions} update in place when signals change.
view Counter(start: int = 0) {
    signal count = start
    signal doubled = count * 2
    <div class="card">
        <h2>Clicked {count} times</h2>
        <p>Doubled: {doubled}</p>
        <button on:click={count += 1}>+1</button>
        <button on:click={count = 0}>Reset</button>
        {count >= 5 && <p>🔥 You're on fire!</p>}
    </div>
}

view Greeter() {
    signal name = "world"
    <div class="card">
        <input bind:value={name} />
        <p>Hello, {name}!</p>
    </div>
}

mount(<Counter start={0} />)
mount(<Greeter />)
`,
  },
  {
    id: "live",
    title: "Live query: data that updates itself",
    code: `model Player {
    id: int
    name: string
    score: int
}

signal minScore = 50
// Re-runs when minScore changes or the Player table is written.
signal leaders = live query Player where score >= minScore order by score desc

effect {
    print("🏆", leaders |> map(fn(p) => "\${p.name} (\${p.score})"))
}

fn main() {
    insert Player { name: "Ana", score: 92 }
    insert Player { name: "Marko", score: 40 }
    insert Player { name: "Mila", score: 70 }
    print("— lowering the bar —")
    minScore = 30
    print("— a new record —")
    update Player set score = 99 where name == "Marko"
}
`,
  },
  {
    id: "match",
    title: "Enums, match & Result with ?",
    code: `enum Shape {
    Circle(radius: float)
    Rect(w: float, h: float)
    Empty
}

fn area(s: Shape) -> float {
    // The compiler checks that every variant is handled.
    return match s {
        Circle(r) => 3.14159 * r * r
        Rect(w, h) => w * h
        Empty => 0.0
    }
}

enum ParseError {
    EmptyInput
    NotANumber(text: string)
}

fn parseAge(text: string) -> Result<int, ParseError> {
    if text == "" { return Err(EmptyInput) }
    let n = int(text)
    if n < 0 { return Err(NotANumber(text)) }
    return Ok(n)
}

fn nextBirthday(text: string) -> Result<int, ParseError> {
    let age = parseAge(text)?      // returns the Err early, unwraps Ok
    return Ok(age + 1)
}

fn main() {
    print([Circle(1.0), Rect(2.0, 3.0), Empty] |> map(area))
    for input in ["41", "", "-3"] {
        match nextBirthday(input) {
            Ok(n) => print("next birthday:", n)
            Err(EmptyInput) => print("please type something")
            Err(NotANumber(t)) => print("not an age:", t)
        }
    }
}
`,
  },
  {
    id: "api",
    title: "REST API in 15 lines (routes)",
    code: `model Todo { id: int, title: string, done: bool }

route GET "/todos" -> List<Todo> {
    return query Todo order by id
}

route POST "/todos" (title: string) -> Todo {
    return insert Todo { title, done: false }
}

route PATCH "/todos/:todoId" (todoId: int, isDone: bool) -> int {
    return update Todo set done = isDone where id == todoId
}

fn main() {
    // request() calls your routes in-process; 'mk serve' exposes them over HTTP.
    request("POST", "/todos", { title: "Write the compiler" })
    request("POST", "/todos", { title: "Ship the playground" })
    request("PATCH", "/todos/1", { isDone: true })
    print(request("GET", "/todos").body)
    print("bad id →", request("PATCH", "/todos/abc", { isDone: true }).body)
    serve(3000)
}
`,
  },
  {
    id: "pipes",
    title: "Pipelines & concurrent map",
    code: `fn fetchScore(name: string) -> int {
    sleep(200)                  // pretend this is an HTTP call
    return len(name) * 10
}

fn main() {
    let started = now()
    let names = ["ana", "marko", "jelena", "stefan"]
    // fetchScore does I/O, so map runs all four calls concurrently.
    let scores = names |> map(fetchScore)
    print(scores, "in ~\${now() - started}ms (not 800ms)")

    let total = scores
        |> filter(fn(s) => s > 40)
        |> sum
    print("total of the big scores:", total)
}
`,
  },
  {
    id: "tests",
    title: "Tests (press ✓ Test)",
    code: `fn fizzbuzz(n: int) -> string {
    if n % 15 == 0 { return "FizzBuzz" }
    if n % 3 == 0 { return "Fizz" }
    if n % 5 == 0 { return "Buzz" }
    return str(n)
}

model Account { id: int, owner: string, balance: int }

fn deposit(accountId: int, amount: int) -> Result<int, string> {
    if amount <= 0 { return Err("amount must be positive") }
    let changed = update Account set balance = balance + amount where id == accountId
    if changed == 0 { return Err("no such account") }
    return Ok(changed)
}

test "fizzbuzz" {
    assert fizzbuzz(9) == "Fizz"
    assert fizzbuzz(10) == "Buzz"
    assert fizzbuzz(30) == "FizzBuzz"
}

test "deposit adds money" {
    insert Account { owner: "Ana", balance: 100 }
    assert deposit(1, 50) == Ok(1)
    let account = query first Account
    assert account?.balance == 150
}

test "deposit rejects negative amounts" {
    assert deposit(1, -5) == Err("amount must be positive")
}

fn main() {
    print("Press ✓ Test to run the test blocks")
}
`,
  },
  {
    id: "signals",
    title: "Reactive signals & effects",
    code: `signal celsius = 20
signal fahrenheit = celsius * 9 / 5 + 32
signal feelsLike = if_hot(celsius)

fn if_hot(c: int) -> string {
    if c >= 30 { return "hot" }
    if c <= 5 { return "cold" }
    return "mild"
}

// Re-runs automatically whenever a signal it reads changes.
effect {
    print("\${celsius}°C = \${fahrenheit}°F, feels \${feelsLike}")
}

celsius = 35
celsius = 35        // same value: no re-run
celsius = -2
`,
  },
  {
    id: "crud",
    title: "Database: model, insert, update, delete",
    code: `model Todo {
    id: int
    title: string
    done: bool
    priority: int
}

fn main() {
    insert Todo { title: "Write the compiler", done: true, priority: 1 }
    insert Todo { title: "Ship the playground", done: false, priority: 1 }
    insert Todo { title: "Tweet about MK", done: false, priority: 2 }
    insert Todo { title: "Water the plants", done: false, priority: 3 }

    let open = query Todo where !done order by priority, title
    for t in open {
        print("[ ]", t.title, "(p\${t.priority})")
    }

    let bumped = update Todo set priority = priority - 1 where !done && priority > 1
    print("bumped", bumped, "todos")

    let urgent = query count Todo where priority == 1 && !done
    print("urgent:", urgent)

    print("removed", delete Todo where done, "finished todos")
    print(query Todo where title.contains("MK") select title, priority)
}
`,
  },
  {
    id: "async",
    title: "Implicit async & spawn",
    code: `// No async, no await — the compiler finds the I/O and inserts them.
fn fetchProfile(name: string, ms: int) -> string {
    sleep(ms)
    return "profile of \${name}"
}

fn main() {
    let started = now()

    // spawn starts tasks concurrently; join waits for all of them.
    let a = spawn fetchProfile("ana", 300)
    let b = spawn fetchProfile("marko", 300)
    let c = spawn fetchProfile("mila", 300)
    print(join(a, b, c))

    print("took ~\${now() - started}ms (not 900ms)")

    // Sequential calls are awaited one after another:
    print(fetchProfile("stefan", 100))
}
`,
  },
  {
    id: "ownership",
    title: "Ownership errors (compile-time)",
    code: `// MK rejects every marked line before the program ever runs.
fn send(consume data: Buffer) {
    print("sent", len(data))
}

fn peek(data: Buffer) {
    send(consume data)          // only borrowed here
}

fn main() {
    let buf = Buffer.alloc(16)
    send(consume buf)
    print(buf.length)           // use after consume

    let other = Buffer.alloc(8)
    send(other)                 // transfer must be explicit

    let maybe = Buffer.alloc(4)
    if len(other) > 4 {
        send(consume maybe)
    }
    send(consume maybe)         // consumed on some paths
}
`,
  },
  {
    id: "fetch",
    title: "Fetch JSON from the web",
    code: `fn stars(repo: string) -> int {
    let info = fetchJson("https://api.github.com/repos/\${repo}")
    return info.stargazers_count
}

fn main() {
    let repo = "maksimkrulj/mkcode"
    print("⭐", repo, "has", stars(repo), "stars — add yours!")
}
`,
  },
];
