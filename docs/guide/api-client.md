# The API client

A request builder and response viewer, scoped to a project, storing its
collections **as files in that project's repository**.

## Collections are files

A collection is a directory containing `bruno.json` — [Bruno's own
format](https://github.com/usebruno/bruno). Jarvis finds them by looking in the
project root and one level below it. Requests are `.bru` files, environments
live in `environments/`.

```
<project>/api/
  bruno.json
  orders/
    list.bru
    create.bru
  environments/
    local.bru
```

This means your requests are diffable, reviewable in a pull request, openable
in Bruno desktop, and runnable in CI with `bru run`. It also means a collection
whose `bruno.json` sits at the root of an ordinary repository shows only the
folders that actually contain requests — not `src/`, `config/` and every
`__pycache__`.

**+ request**, **+ folder**, **+ collection** and **import** are in the
sidebar; ✎ and × on a row rename and delete. Renaming a request moves the file
*and* rewrites its `meta.name`, since that is the name everything displays.

## Sending

`⌘Enter` sends, `⌘S` saves. **cURL** copies the request as a shell command with
variables resolved — a command with `{{base}}` still in it is a note, not a
command.

Requests are issued **from the main process**, not from a browser origin.
That is why CORS never applies here, and it is the reason this is a native tab
rather than a hosted web app.

## Variables and environments

`{{name}}` resolves from the selected environment. **env** opens the editor:
add, rename and remove variables, and mark one *secret*.

A variable with no value is **left as its literal** and reported beside the
response, rather than blanked. A request to `https:///api` is a confusing
failure; `{{base}}/api` says exactly what is missing. When the URL itself
depends on a missing variable, the failure names it.

## Auth

**bearer**, **basic**, **apikey** (header or query) and **oauth2**. The OAuth2
grants are client credentials, password, and authorization code — the last
drives its redirect through a Workspace tab, so you approve in the app rather
than copying a code back from another browser.

## Bodies

`json`, `text`, `xml`, `graphql`, form-urlencoded and multipart. The JSON body
says whether it is valid JSON and why not when it isn't; **format** pretty-
prints it and leaves anything half-typed alone. Multipart file fields are
chosen through the system picker — a hand-typed path is how you get a request
that fails at send time on a file that never existed.

## Assertions, scripts and tests

An `assert` block is **evaluated**: a target (`res.status`, `res.body.a.b`,
`res.headers.content-type`, `res.responseTime`), an operator, an operand. Each
result says what it actually got, because a failure that only says "failed"
sends you back to guess.

`script:pre-request`, `script:post-response` and `tests` **run**, in a context
holding `bru`, `req`, `res`, `console`, `expect` and `test`. Variables a
pre-request script sets are available to the request that follows. What they
print appears on the **console** tab; their assertions are counted beside the
declarative ones.

> These scripts come from your own repository, and Jarvis already runs that
> repository's code — the Terminal tab is a login shell in it and the Editor is
> a full VS Code. A `.bru` script is not a new trust boundary. What the
> sandbox provides is containment against accident and a timeout so a runaway
> loop cannot take the window with it; it is not a security boundary and is not
> treated as one.

## Cookies, history and network settings

**cookies** shows the jar — per project, persisted, with the flags that decide
whether each cookie is sent. A login that answers `302` with `Set-Cookie` is
handled: redirects are followed by hand so the cookie is caught on the hop that
set it.

**hist** shows the last 200 calls per project. **net** sets a proxy,
a timeout, and whether to verify certificates. Verification is on unless you
turn it off.

## What is not here

No cookie *editor* (only viewing and deleting), no code generation beyond
cURL, no response search, and no per-request network override — the settings
are per project. Postman import handles v2.0 and v2.1 collections.
