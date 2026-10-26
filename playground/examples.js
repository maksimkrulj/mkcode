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
