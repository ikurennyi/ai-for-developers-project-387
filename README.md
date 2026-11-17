# Календарь звонков


[![hexlet-check](https://github.com/ikurennyi/ai-for-developers-project-387/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/ikurennyi/ai-for-developers-project-387/actions)
[![application-check](https://github.com/ikurennyi/ai-for-developers-project-387/actions/workflows/application-check.yml/badge.svg)](https://github.com/ikurennyi/ai-for-developers-project-387/actions/workflows/application-check.yml)

Разработайте совместно с ИИ сервис для бронирования календаря

Учебный проект Хекслета: https://ru.hexlet.io/programs/ai-for-developers
Как это должно работать: https://files.hexlet.app/a/2ipc5m

## Первый шаг: каркас приложения

- [Исходные требования шага](1-step.md).
- [Утверждённая спецификация первого проекта](https://github.com/ikurennyi/ai-for-developers-project-386/issues/1).
- Исходная спецификация: [SPECIFICATION.md](SPECIFICATION.md); словарь: [GLOSSARY.md](GLOSSARY.md).
- [Закреплённые инструменты](docs/toolchain.md), [локальная приёмка и открытые критерии](docs/acceptance.md).

Главная страница рассказывает о сервисе; Book a meeting открывает список
опубликованных типов встреч с сервера. Публичная ссылка открывает календарь:
можно выбрать свободный интервал Europe/Berlin, заполнить данные гостя и явно
подтвердить бронирование. Общая занятость атомарно защищена PostgreSQL.
Безопасный вход администратора реализован; управление бронированиями пока отсутствует.
Локальный прогон не подтверждает зелёный GitHub Actions: внешний CI и итоговый
review пока не подтверждены, родительская спецификация не объявляется выполненной.

## Запуск приложения

Старый публичный адрес предыдущего проекта: [ai-for-developers-project-386-ddst.onrender.com](https://ai-for-developers-project-386-ddst.onrender.com) (доступность не подтверждена). Для гарантированного локального запуска используйте Docker:

Нужны mise и работающий Docker Engine. Подробности и требования к локальному сертификату: [Docker application](docs/docker.md).

```sh
git clone https://github.com/ikurennyi/ai-for-developers-project-387.git
cd ai-for-developers-project-387
mise trust mise.toml
mise install
HTTPS_PORT=8443 mise exec -- ruby scripts/docker.rb setup
mise exec -- ruby scripts/docker.rb build
mise exec -- ruby scripts/docker.rb up
```

Откройте `https://localhost:8443` и примите предупреждение браузера о локальном сертификате. Начальные данные администратора находятся в локальном файле `.services/docker.env`; не публикуйте его. Команды остановки и дальнейшего управления описаны в [Docker application](docs/docker.md).

### Подключение Render MCP в OpenCode

В проектном `opencode.json` настроен официальный удалённый Render MCP endpoint.
Чтобы авторизоваться:

1. Откройте репозиторий в OpenCode и выполните `/mcps`.
2. Выберите `render` и завершите OAuth в браузере.
3. Убедитесь, что сервер отображается как `connected`; при запросе действий
   укажите нужный Render workspace.

OAuth-токены хранятся OpenCode вне репозитория. Не записывайте API keys или
токены в конфигурацию проекта. Для других MCP-клиентов добавляйте
`https://mcp.render.com/mcp` через их настройки и используйте OAuth, если он
поддерживается.

## Стек

- Rails API / Ruby, PostgreSQL; Vue 3, Router, TypeScript и Element Plus.
- TypeSpec → OpenAPI 3.0 → generated Fetch SDK; RSpec и Vitest (включая Chromium).
- mise, Docker Compose, pitchfork, hk и commitlint.

## Установка

Нужны [mise 2026.11.6 и закреплённые инструменты](docs/toolchain.md), работающий
Docker Engine и системные зависимости сборки Ruby/pg (libpq, компилятор).
mise устанавливает Docker CLI, но не Docker Engine/VM.

```bash
git clone https://github.com/ikurennyi/ai-for-developers-project-387.git
cd ai-for-developers-project-387
mise trust mise.toml
mise install
mise exec -- gem install bundler -v 4.0.22 --no-document
mise run install
```

`install` использует frozen Bundler и отдельный `npm ci` в `contracts/`,
`frontend/`, `tooling/`, затем устанавливает Chromium. На Linux нужны также
системные библиотеки браузера:

```sh
mise exec -- node frontend/node_modules/playwright/cli.js install --with-deps chromium
```

## Использование

Для запуска приложения целиком в контейнерах из чистого checkout, с HTTPS,
миграциями и постоянной БД: [Docker application](docs/docker.md).

Для каждого checkout/worktree создайте отдельную игнорируемую конфигурацию.
Не перезаписывайте существующий `mise.local.toml`: шаблон меняет пароль.

```sh
umask 077
mise exec -- ruby scripts/services.rb dev:env > mise.local.toml
# Выберите три свободных разных порта; при смене POSTGRES_PORT обновите оба URL.
mise trust mise.local.toml
mise run dev:validate
mise run db:up
mise run db:prepare
mise run dev:start
mise run db:seed
mise run dev:status
```

Откройте `http://127.0.0.1:<FRONTEND_PORT>/`: страница показывает
`API healthy: ok`, полученный через SDK и Vite proxy от Rails
`GET /api/v1/health`. Health не доказывает подключение БД; smoke проверяет его отдельно.
`dev:start` также сам подготавливает БД. Повторный start при занятых портах — ошибка.

`mise run db:seed` создаёт отсутствующие опубликованные 15- и 30-минутные типы
встреч. Команда безопасна для повторного запуска: она сохраняет изменения
названий, описаний, длительности, адресов и публикации. Начальные предложения
распознаются по постоянному служебному ключу, не по адресу.
Данные и технические UUID хранятся в PostgreSQL, а не в памяти приложения.
`dev:env` также генерирует локальные `ADMIN_USERNAME`/`ADMIN_PASSWORD`;
единственный администратор создаётся при первом входе. Сохраните конфигурацию
приватно и не перегенерируйте её для уже работающей базы.
Публичный `GET /api/v1/meeting-types` возвращает только опубликованные предложения;
пустой список отображается как “No meeting types available”.

Календарь доступен по `/book/<slug>` и читает через generated SDK
`GET /api/v1/meeting-types/<slug>/availability`. Скрытые и несуществующие адреса
одинаково недоступны. Окно — сегодня и следующие 13 дат Europe/Berlin;
расписание пн–пт 09:00–18:00, шаг стартов 15 минут.
Выбор и Continue ничего не записывают и не резервируют; Confirm booking сохраняет
бронирование и показывает данные встречи без обещаний отправки письма.
Правила общей занятости: [calendar](docs/calendar.md);
API подтверждения и границы следующих этапов: [confirmation](docs/booking-confirmation.md).

```sh
mise run dev:stop
```

Остановка сохраняет данные и затрагивает только этот worktree. Идентификаторы,
переменные, диагностика и смена настроек описаны в [dev-services](docs/dev-services.md).

## Проверки и hooks

Настройка единственного администратора, ограничения попыток входа и серверная
команда смены пароля с отзывом всех сессий: [Administrator access](docs/admin-authentication.md).

```sh
mise run check
mise run hooks:install
mise run hooks:test
mise run commits:test
mise run ci:validate
```

`check` не требует dev-сервисов или локальной конфигурации: он запускает все
контрактные проверки, lint, форматирование, типы, RSpec, Vitest/jsdom,
настоящий Chromium smoke и production build. Docker должен работать.
Проверки не исправляют и не индексируют исходники.

- [Все отдельные команды и failure probes](docs/checks.md).
- [Chromium, изоляция и cleanup](docs/chromium-smoke.md).
- [Hooks, commit ranges и CI](docs/hooks-and-ci.md). Установка hooks явная,
  локальная для репозитория; linked worktree могут разделять hooks.
- [Версионирование и release PR](docs/releases.md): единая версия приложения,
  настройка отдельного токена maintainer-ом и ещё не подтверждённые внешние шаги.
- Коммиты: Conventional Commits, например `docs: clarify local setup`;
  ветки: `docs/short-description`, PR titles — также Conventional Commits.

Приложение проверяется отдельным `.github/workflows/application-check.yml` на
push/PR той же командой `mise run check`. Push/PR требуют отдельного разрешения;
результаты внешнего CI не выводятся из локального успеха.

## Агент OpenCode в GitHub

Workflow разделены по назначению:

| Файл | События | Назначение |
| --- | --- | --- |
| `.github/workflows/issue-triage.yml` | `issues: [opened]` | Автоматический предварительный разбор новых обращений |
| `.github/workflows/opencode.yml` | `issue_comment`, `pull_request_review_comment`, оба `types: [created]` | Ручные команды, обсуждение и публикация спецификаций/тикетов |

Для комментариев требуется отдельная команда `/oc` или `/opencode`.
Это явный набор команд вызова (mentions).
Допускаются только авторы с `author_association` OWNER, MEMBER или COLLABORATOR;
обычный CONTRIBUTOR не входит в список. Боты, редактирование комментариев
и комментарии без команды не запускают модель.

Для запуска workflow добавьте ключ OpenCode Console в
**Settings → Secrets and variables → Actions** под именем `OPENCODE_API_KEY`.
Модель выбирается независимо в `jobs.<job>.env.OPENCODE_MODEL` каждого YAML:
можно назначить одну для автотриажа, другую для ручной работы.
Пока в обоих используется бесплатная `opencode/glm-5.3-flash-free` через OpenCode
Console. При смене провайдера отдельно настройте его секрет и переменную
авторизации в шаге модели соответствующего workflow.
Бесплатный доступ предоставляется на ограниченный период и может иметь
лимиты доступности или запросов; успешный запуск не гарантирован. Не передавайте
агенту секреты и чувствительную информацию.

Официальная GitHub Action OpenCode удалена из текущего OpenCode. Поэтому
оба workflow используют CLI `@opencode/cli` и ограниченный `GITHUB_TOKEN`, а не
установленное GitHub App. Автотриаж получает только `contents: read` и
`issues: write`; ручной workflow дополнительно получает `pull-requests: write`
для ответов в review threads. Токен не может записывать
изменения в код. Агент работает с GitHub напрямую через `gh`, без собственного
JSON-протокола и отдельного скрипта-публикатора.

Разрешения инструментов заданы в `.opencode/agents/` по принципу default deny:

| Агент | Разрешённые shell-команды |
| --- | --- |
| `github-triage` | `gh issue view/list`, проверка имени репозитория |
| `github-issues` | Дополнительно `gh issue create/comment/edit`, `gh --version` |

Обоим доступны read/glob/grep и скиллы. Изменение локальных файлов, произвольный
shell, git/push, создание PR, закрытие/удаление issues, произвольный `gh api`,
MCP и субагенты запрещены. Вызовы браузера/редактора и ввод тела через файл
(`--body-file`/`-F`) также запрещены; агент передаёт текст через `--body`.
Это ограничения инструментов, а не только пожелания в prompt.
Разрешение `gh issue edit` ручного агента позволяет менять тело/метаданные issues,
не только метки; человеческое согласование объёма обеспечивается workflow
обсуждения, а не гранулярностью токена. Allowlist не является OS sandbox.

Checkout явно закреплён на основной ветке:
fork-код не checkout-ится и не исполняется;
workflow не использует `pull_request_target`. Ответы публикуются от
`github-actions[bot]`.

Сессии не публикуются (решение по share: выключено):
CLI-запуски архивируются на эфемерном runner-е.
Проектные скиллы из `.agents/skills/` доступны на свежем runner-е через
совместимый поиск OpenCode V2; глобальная установка скиллов не нужна.
Результат смотрите в ответе агента в issue/PR и в **Actions → Issue triage**
или **Actions → OpenCode agent**. В обоих workflow задан тайм-аут 15 минут
и общая concurrency-группа по номеру issue/PR: автоматический и ручной запуск
для одного обращения не выполняются одновременно.
Текущий запуск можно отменить в Actions; workflow можно отключить, чтобы
предотвратить новые запуски. Запрос, уже переданный провайдеру, может
продолжиться по его правилам; при необходимости отзовите ключ OpenCode Console.
Установленное OpenCode GitHub App можно оставить, но эти workflow его не
используют.

### Обращение → спецификация → тикеты

Все изменения проекта проходят через GitHub issue, отдельную ветку и связанный
PR. Продуктовое обращение создаёт человек: достаточно описать проблему без
готового технического решения. Вся переписка и согласования остаются в GitHub.

1. Создайте issue. Автотриаж проверит существующий код, оставит выводы и вопросы.
   Это предварительный разбор, не разрешение на реализацию.
2. Ответьте в обсуждении и позовите агента:
   `/oc разбери обращение по скиллу triage, код пока не меняй`.
   Обычный ответ без команды не вызывает модель.
3. Попросите `/oc запусти скилл to-spec по обсуждению этого issue`.
   Агент предложит сценарии и границы тестирования; согласуйте их в issue.
   После ответов позовите его снова: `/oc продолжи to-spec с учётом ответов`.
   Скилл публикует спецификацию как связанную issue через `gh`.
4. Попросите `/oc запусти скилл to-tickets по спецификации #N`.
   Проверьте предложенные вертикальные задачи, критерии и зависимости.
   Согласуйте разбиение в исходном обращении и попросите продолжить `to-tickets`:
   скилл опубликует связанные тикеты.
   `#N` — номер опубликованной спецификации в этом репозитории.
5. Прочитайте опубликованные артефакты и **сами** оставьте в исходном issue
   комментарий с явным одобрением спецификации и списка тикетов, перечислив
   ссылки. Публикация черновиков и метка `ready-for-agent` не заменяют одобрение.
6. Передайте ссылки на обращение, спецификацию, тикеты и комментарий согласования
   в следующую сессию `implement-spec`. Она должна сохранить ссылку согласования
   в PR; изменение объёма требует нового согласования.

GitHub runner готовит задания, но **не реализует код**, в том числе по команде
`implement-spec`. Реализация выполняется отдельным агентом с соответствующими
правами через issue → ветку → PR. Push, создание PR и merge требуют разрешения.

Автотриаж использует явный `TRIAGE_PROMPT` в `issue-triage.yml`. Метки и правила пропуска
заданы в [настройках триажа](docs/agents/triage-labels.md) и
профилях агентов. Спецификации (`agent:spec`) и тикеты
(`agent:ticket`) создаются сразу с `ready-for-agent`; подготовленные issues
пропускаются до вызова модели. Все необходимые метки уже созданы в репозитории.
Для нового репозитория maintainer создаёт их заранее через `gh label create`.
Native связи используются, если их поддерживает установленный `gh`; иначе
тикеты содержат Parent/Part of/Blocked by ссылки. Произвольный API агенту недоступен.

В автотриаже метку `needs-triage` выставляет фиксированный шаг workflow, только
если нет другой метки состояния. Модель лишь читает данные и рекомендует
категорию/следующее состояние; её ответ публикует workflow. Применение решений
и дальнейшая работа выполняются ручным агентом по команде человека.

Workflow передаёт исходное issue и всю переписку с пагинацией; агент читает
связанные спецификации/тикеты и их обсуждения через `gh`. Перед созданием он
проверяет существующие артефакты во всех состояниях, включая закрытые.
Автоматической гарантии exactly-once нет: после частичного сбоя сначала
проверьте результат и попросите `/oc` продолжить с учётом уже созданного.
Не перезапускайте публикацию вслепую. Существенное изменение объёма требует
нового человеческого согласования.

Проверки механизма: `mise run ci:validate` (actionlint, политики workflow,
тесты фильтров workflow и allowlist/deny правил инструментов).
Для внешней проверки после merge в основную ветку создайте новое обращение и
проверьте ответ/метки в Actions; затем создайте тестовую issue сразу с
`ready-for-agent` и убедитесь, что шаг модели пропущен. Проверьте также `/oc`,
публикацию спецификации и тикетов после согласования. Созданные через
`GITHUB_TOKEN` issues обычно не запускают новый Actions workflow: поэтому
пропуск проверяется и отдельной issue, созданной человеком.
Локальные тесты не подтверждают успешный вызов модели или внешнего Actions.

---

<details>
<summary>Автоматические тесты Хекслета</summary>

Тесты запускаются на каждый коммит. За запуск отвечает файл `.github/workflows/hexlet-check.yml` — не удаляйте и не переименовывайте ни его, ни репозиторий.

</details>

## О Хекслете

[Хекслет](https://ru.hexlet.io/) — школа программирования: авторские программы обучения с практикой, поддержкой наставников и реальными проектами, которые остаются в резюме. Этот репозиторий — один из таких проектов.
