// A live query: the signal re-runs when `minScore` changes or the Player table is written.

model Player {
    id: int
    name: string
    score: int
}

signal minScore = 50
signal leaders = live query Player where score >= minScore order by score desc

effect {
    print("🏆", leaders |> map(fn(p) => "${p.name} (${p.score})"))
}

fn fetchBonus(name: string) -> int {
    sleep(50)                     // pretend this is an API call
    return len(name)
}

fn main() {
    insert Player { name: "Ana", score: 92 }
    insert Player { name: "Marko", score: 40 }
    insert Player { name: "Mila", score: 70 }

    minScore = 30
    sleep(10)                     // let the re-run land before the next write

    // fetchBonus does I/O, so map runs the calls concurrently.
    let bonuses = ["Ana", "Marko", "Mila"] |> map(fetchBonus)
    print("bonuses:", bonuses)
    update Player set score = score + 10 where name == "Marko"
}
