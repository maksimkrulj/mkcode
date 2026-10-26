// A complete REST API with a SQLite-ready schema, a server-rendered page and tests.
//   mk serve examples/todo-api.mk --watch      → http://localhost:3000
//   mk test examples/todo-api.mk
//   mk db migrate examples/todo-api.mk --db todos.sqlite

model Todo {
    id: int
    title: string
    done: bool
}

route GET "/todos" -> List<Todo> {
    return query Todo order by id
}

route GET "/todos/:todoId" (todoId: int) -> Todo? {
    return query first Todo where id == todoId
}

route POST "/todos" (title: string) -> Todo {
    return insert Todo { title, done: false }
}

route PATCH "/todos/:todoId" (todoId: int, isDone: bool) -> int {
    return update Todo set done = isDone where id == todoId
}

route DELETE "/todos/:todoId" (todoId: int) -> int {
    return delete Todo where id == todoId
}

view TodoPage(todos: List<Todo>) {
    <main>
        <h1>Todos ({len(todos)})</h1>
        <ul>{todos |> map(fn(t) => <li class={match t.done { true => "done", false => "open" }}>{t.title}</li>)}</ul>
    </main>
}

route GET "/" -> Markup {
    let todos = query Todo order by id
    return <TodoPage todos={todos} />
}

test "POST creates a todo" {
    let created = request("POST", "/todos", { title: "Ship MK" })
    assert created.status == 200
    assert created.body.title == "Ship MK"
    assert (query count Todo) == 1
}

test "PATCH marks a todo as done" {
    insert Todo { title: "Write docs", done: false }
    let r = request("PATCH", "/todos/1", { isDone: true })
    assert r.body == 1
    assert (query first Todo)?.done == true
}

test "bad input is rejected with 400" {
    assert request("POST", "/todos", {}).status == 400
    assert request("GET", "/todos/abc").status == 400
    assert request("GET", "/todos/99").status == 404
}

test "the home page renders HTML" {
    insert Todo { title: "Learn MK", done: false }
    let page = request("GET", "/")
    assert "<li class=\"open\">Learn MK</li>" in page.text
}
