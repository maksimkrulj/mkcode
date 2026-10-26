// A tour of MK: schemas, reactive signals, implicit async, ownership and tasks.
import { average, clamp } from "./lib/stats.mk"

model User {
    id: int
    name: string
    score: int
    status: string
    email: string?
}

signal threshold = 60
signal label = "threshold is ${threshold}"

// Re-runs whenever `label` (and therefore `threshold`) changes.
effect {
    print("[effect]", label)
}

fn seed() {
    insert User { name: "Ana", score: 92, status: "active" }
    insert User { name: "Marko", score: 47, status: "active" }
    insert User { name: "Jelena", score: 78, status: "inactive", email: "jelena@example.com" }
    insert User { name: "Stefan", score: 65, status: "active" }
}

fn topUsers(min: int) -> List<User> {
    return query User
        where score >= min && status == "active"
        order by score desc
}

// Takes ownership: the caller can't touch `users` afterwards.
fn report(consume users: List<User>) -> string {
    let names = users.map(fn(u) => u.name).join(", ")
    return "${len(users)} users: ${names}"
}

fn main() {
    seed()
    let users = topUsers(threshold)
    print(report(consume users))

    threshold = 50
    let bonus = update User set score = score + 5 where status == "active" && score < 70
    print("bonus for", bonus, "users")

    let removed = delete User where status == "inactive"
    print("removed", removed)

    // Two queries run concurrently; join waits for both.
    let total = spawn query count User
    let firstS = spawn query first User where name.startsWith("S")
    let results = join(total, firstS)
    print("count:", results[0], "| first S:", results[1].name, results[1].score)

    let scores = (query User select score).map(fn(u) => u.score)
    print("average:", average(scores), "| clamped:", clamp(120, 0, 100))

    for i in 0..3 {
        print("tick", i)
    }
}
