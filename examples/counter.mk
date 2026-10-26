// UI components. In the playground (Preview tab) these are live DOM; under Node, mount() prints HTML.

view Counter(start: int = 0) {
    signal count = start
    signal doubled = count * 2
    <div class="card">
        <h2>Clicked {count} times</h2>
        <p>Doubled: {doubled}</p>
        <button on:click={count += 1}>+1</button>
        <button on:click={count = 0}>Reset</button>
        {count >= 5 && <p>You're on fire!</p>}
    </div>
}

view Greeter() {
    signal name = "world"
    <div class="card">
        <input bind:value={name} />
        <p>Hello, {name}!</p>
    </div>
}

mount(<Counter start={3} />)
mount(<Greeter />)
