FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
RUN npm install --global @opencode/cli@2.3.0
COPY tooling/agent-runner/opencode.json /etc/opencode/opencode.json
COPY .opencode/agents/github-implementer.md /policy/.opencode/agents/github-implementer.md
COPY .agents/skills/implement-spec /policy/.agents/skills/implement-spec
WORKDIR /policy
USER node
ENTRYPOINT ["opencode", "run", "--standalone", "--archived"]
