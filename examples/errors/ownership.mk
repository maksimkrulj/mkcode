// `mk check` rejects every marked line at compile time.
fn send(consume data: Buffer) {
    print("sent", len(data))
}

fn peek(data: Buffer) {
    send(consume data)          // MK3008: 'data' is only borrowed here
}

fn main() {
    let buf = Buffer.alloc(16)
    send(consume buf)
    print(buf.length)           // MK3001: use after consume

    let other = Buffer.alloc(8)
    send(other)                 // MK3010: ownership transfer must be explicit

    let maybe = Buffer.alloc(4)
    if len(other) > 4 {
        send(consume maybe)
    }
    send(consume maybe)         // MK3002: consumed on some paths

    let shared = Buffer.alloc(2)
    let later = fn() => print(shared)
    send(consume shared)        // MK3007: a closure still holds 'shared'
}
