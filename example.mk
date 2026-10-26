// Signal Reactive Primitives
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
