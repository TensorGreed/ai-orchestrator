# Authentication and RBAC

## Session model

- Login creates a persisted session record in SQLite.
- API sets an `httpOnly` cookie (`SESSION_COOKIE_NAME`).
- Frontend uses `credentials: include`.

## Roles

- `admin`
- `builder`
- `operator`
- `viewer`

## Access model summary

- Workflow read: all authenticated roles
- Workflow create/update/delete: `builder`, `admin`
- Execute workflow/webhook API trigger: `builder`, `admin`
- Secrets list/create: `builder`, `admin`
- User registration:
  - first-user bootstrap or public registration (as configured)
  - `admin` can create admin users

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Error contracts

- `401` unauthenticated / invalid session
- `403` authenticated but unauthorized
