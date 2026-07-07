#!/bin/sh
# =============================================================================
#  Bootstrap da máquina para o AI Product BMAD Chat — rede corporativa (Itaú)
# -----------------------------------------------------------------------------
#  Prepara SOMENTE o que precisa existir ANTES de instalar o portal via npm:
#    1. Instala a CA corporativa em ~/certs (se ainda não estiver lá)
#    2. Configura registry + cafile + strict-ssl/always-auth no npm (~/.npmrc)
#    3. Instala o uv (gerenciador Python do MCP ConsumerLab) com pip — com
#       fallback no instalador oficial via curl, que roda até no Git Bash —
#       e o deixa no PATH (mac/linux no rc; Windows no registro do usuário)
#    4. Grava as variáveis de ambiente (NODE_EXTRA_CA_CERTS,
#       NODE_TLS_REJECT_UNAUTHORIZED=0 e proxy com usuário RACF):
#         - mac/linux: no rc do shell (~/.zshrc, ~/.bashrc, ~/.profile)
#         - Windows (Git Bash): no REGISTRO do usuário via setx
#
#  As demais verificações (git, python, AWS CLI, conectividade) são feitas
#  pelo próprio portal, na tela de Diagnóstico, após a instalação.
#
#  Roda com sh/bash/zsh no mac/linux E no Git Bash do Windows. Uso:
#    sh bootstrap-itau.sh            # aplica tudo (idempotente — pode repetir)
#    sh bootstrap-itau.sh --undo     # desfaz tudo que o script configurou
#    sh bootstrap-itau.sh --help
#
#  Depois de aplicar: FECHE e reabra o terminal e o VS Code (pra reler o ambiente).
# =============================================================================
set -u

# ---------------------------------------------------------------------------
#  CONFIG — PREENCHA ESTES VALORES
# ---------------------------------------------------------------------------

# Proxy corporativo. Só o host:porta aqui — o usuário (RACF) e a senha são
# pedidos NA HORA e embutidos como http://USER:SENHA@host:porta.
# Deixe PROXY_HOST="" se a rede não usa proxy.
PROXY_HOST="proxynew.itau:8080"    # ex.: proxynew.itau:8080

# Hosts que NÃO devem passar pelo proxy.
NO_PROXY_LIST="localhost,127.0.0.1,::1,.itau,.cloud.itau.com.br"

# Registry npm interno (Artifactory). Deixe "" para pular a configuração de npm.
REGISTRY_URL=""                    # ex.: https://artifactory.itau/api/npm/npm-virtual/

# Instalar o uv (gerenciador Python do MCP ConsumerLab)? "1" sim, "0" pula.
INSTALL_UV="1"

# (Opcional) URL pronta que sobrescreve tudo; se preenchida, não pergunta nada.
PROXY_URL=""
PROXY_MASK=""

# Onde a CA corporativa fica guardada.
CERT_DIR="$HOME/certs"
CERT_NAME="itau-corp-ca.pem"

# ---------------------------------------------------------------------------
#  CONTEÚDO DA CA CORPORATIVA (.pem)
#  Cole o certificado entre BEGIN/END, substituindo o placeholder.
#  Pode colar VÁRIOS blocos BEGIN/END (cadeia completa) se precisar.
# ---------------------------------------------------------------------------
CERT_PEM=$(cat <<'PEM'
-----BEGIN CERTIFICATE-----
COLE_AQUI_O_CONTEUDO_DO_PEM_DA_CA_CORPORATIVA
-----END CERTIFICATE-----
PEM
)

# =============================================================================
#  Daqui pra baixo não precisa mexer.
# =============================================================================
CERT_PATH="$CERT_DIR/$CERT_NAME"
BLOCK_BEGIN="# >>> ai-portal bootstrap (itau) >>>"
BLOCK_END="# <<< ai-portal bootstrap (itau) <<<"

# Git Bash / MSYS no Windows? (uname → MINGW*/MSYS*/CYGWIN*)
IS_WINDOWS=0
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac
# Caminho do cert no formato que os apps NATIVOS (node/npm) entendem.
# No Git Bash o path é /c/Users/... — cygpath -m devolve C:/Users/... .
CERT_PATH_NATIVE="$CERT_PATH"
if [ "$IS_WINDOWS" -eq 1 ] && command -v cygpath >/dev/null 2>&1; then
  CERT_PATH_NATIVE=$(cygpath -m "$CERT_PATH")
fi
# Variáveis de ambiente que o script gerencia (usado no undo do Windows).
MANAGED_VARS="NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED SSL_CERT_FILE REQUESTS_CA_BUNDLE AWS_CA_BUNDLE HTTPS_PROXY HTTP_PROXY https_proxy http_proxy NO_PROXY no_proxy"

# cores só quando saída é um terminal
if [ -t 1 ]; then
  C_RED=$(printf '\033[31m');   C_GRN=$(printf '\033[32m')
  C_YEL=$(printf '\033[33m');   C_BLD=$(printf '\033[1m'); C_RST=$(printf '\033[0m')
else
  C_RED=; C_GRN=; C_YEL=; C_BLD=; C_RST=
fi
ok()   { printf '%s\n' "${C_GRN}✓${C_RST} $*"; }
warn() { printf '%s\n' "${C_YEL}⚠${C_RST} $*"; }
err()  { printf '%s\n' "${C_RED}✗${C_RST} $*"; }
section() { printf '\n%s\n' "${C_BLD}$*${C_RST}"; }

# URL-encode (RFC 3986) — senha/usuário de RACF podem ter @ # $ etc., que
# quebram a URL do proxy se não forem escapados.
urlencode() {
  _s="$1"; _o=""
  while [ -n "$_s" ]; do
    _c=$(printf '%s' "$_s" | cut -c1)
    case "$_c" in
      [a-zA-Z0-9.~_-]) _o="$_o$_c" ;;
      *) _o="$_o$(printf '%%%02X' "'$_c")" ;;
    esac
    _s=$(printf '%s' "$_s" | cut -c2-)
  done
  printf '%s' "$_o"
}
# Esconde a senha do proxy ao exibir no terminal/log.
mask_proxy() { printf '%s' "$1" | sed -E 's#(//[^:/@]+:)[^@]*@#\1****@#'; }

# --- ~/.npmrc direto (chave=valor) ------------------------------------------
# npm >= 9 rejeita chaves como always-auth no `npm config set` ("not a valid
# npm option"), mas o Artifactory ainda precisa dela no arquivo — então essas
# chaves são gravadas/removidas editando o ~/.npmrc na mão (idempotente).
NPMRC="$HOME/.npmrc"
npmrc_set() {
  _k="$1"; _v="$2"
  touch "$NPMRC"
  _tmp=$(mktemp)
  grep -v "^$_k=" "$NPMRC" > "$_tmp" 2>/dev/null || true
  printf '%s=%s\n' "$_k" "$_v" >> "$_tmp"
  cat "$_tmp" > "$NPMRC"; rm -f "$_tmp"
}
npmrc_unset() {
  _k="$1"
  [ -f "$NPMRC" ] || return 1
  grep -q "^$_k=" "$NPMRC" 2>/dev/null || return 1
  _tmp=$(mktemp)
  grep -v "^$_k=" "$NPMRC" > "$_tmp" 2>/dev/null || true
  cat "$_tmp" > "$NPMRC"; rm -f "$_tmp"
}

# --- uv (gerenciador Python do ConsumerLab) ---------------------------------
uv_bin() { if [ "$IS_WINDOWS" -eq 1 ]; then printf 'uv.exe'; else printf 'uv'; fi; }

# Diretório de scripts do Python (onde `pip install --user` põe o uv).
python_scripts_dirs() {
  _code="import sysconfig,site,os;print(sysconfig.get_path('scripts'));print(os.path.join(site.getuserbase(),'Scripts' if os.name=='nt' else 'bin'))"
  for _py in python3 python py; do
    command -v "$_py" >/dev/null 2>&1 || continue
    _out=$("$_py" -c "$_code" 2>/dev/null)
    if [ -n "$_out" ]; then printf '%s\n' "$_out"; return 0; fi
  done
}

# Diretórios onde o uv costuma cair: pip --user, instalador oficial, cargo, brew.
uv_candidate_dirs() {
  printf '%s\n' "$HOME/.local/bin" "$HOME/.cargo/bin"
  case "$(uname -s 2>/dev/null)" in
    Darwin)
      printf '%s\n' "/opt/homebrew/bin" "/usr/local/bin"
      if [ -d "$HOME/Library/Python" ]; then
        for _v in "$HOME/Library/Python"/*; do
          [ -d "$_v/bin" ] && printf '%s\n' "$_v/bin"
        done
      fi ;;
  esac
  python_scripts_dirs
}

# Primeiro diretório candidato que realmente tem o uv (ou vazio).
find_uv_dir() {
  _b=$(uv_bin)
  uv_candidate_dirs | while IFS= read -r _d; do
    [ -n "$_d" ] && [ -f "$_d/$_b" ] && { printf '%s\n' "$_d"; break; }
  done
}

MODE="apply"
case "${1:-}" in
  --undo|-u|undo)    MODE="undo" ;;
  --help|-h|help)    MODE="help" ;;
  ""|--apply|apply)  MODE="apply" ;;
  *) err "Opção desconhecida: $1"; echo "Use --help"; exit 2 ;;
esac

if [ "$MODE" = "help" ]; then
  sed -n '/^#  Bootstrap/,/reler o ambiente/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ---------------------------------------------------------------------------
#  Arquivos de rc a usar. APPLY grava no rc do shell atual + ~/.profile;
#  UNDO limpa de todos os candidatos conhecidos (não importa o shell).
# ---------------------------------------------------------------------------
rc_targets_apply() {
  case "${SHELL:-}" in
    *zsh*)  printf '%s\n' "$HOME/.zshrc" ;;
    *bash*) printf '%s\n' "$HOME/.bashrc" "$HOME/.bash_profile" ;;
    *)      : ;;
  esac
  printf '%s\n' "$HOME/.profile"          # fallback universal (sh de login)
}
rc_targets_all() {
  printf '%s\n' "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"
}

# Remove o bloco gerenciado (entre os marcadores) de um arquivo.
strip_block() {
  f="$1"
  [ -f "$f" ] || return 0
  awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
    $0==b {skip=1; next}
    $0==e {skip=0; next}
    skip!=1 {print}
  ' "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
}

# =============================================================================
#  MODO UNDO
# =============================================================================
if [ "$MODE" = "undo" ]; then
  section "Desfazendo a configuração do portal…"

  # 1. variáveis de ambiente
  if [ "$IS_WINDOWS" -eq 1 ]; then
    # Windows: apaga do registro do usuário (HKCU\Environment)
    for v in $MANAGED_VARS; do
      if reg query "HKCU\\Environment" /v "$v" >/dev/null 2>&1; then
        reg delete "HKCU\\Environment" /v "$v" /f >/dev/null 2>&1 && ok "Variável $v removida do registro"
      fi
    done
  else
    # POSIX: limpa o bloco de todos os rc conhecidos
    rc_targets_all | sort -u | while IFS= read -r f; do
      if [ -f "$f" ] && grep -qF "$BLOCK_BEGIN" "$f" 2>/dev/null; then
        strip_block "$f"; ok "Bloco removido de $f"
      fi
    done
  fi

  # 2. npm
  if command -v npm >/dev/null 2>&1; then
    for key in registry cafile; do
      cur=$(npm config get "$key" 2>/dev/null)
      if [ -n "$cur" ] && [ "$cur" != "undefined" ] && [ "$cur" != "null" ]; then
        npm config delete "$key" 2>/dev/null && ok "npm config $key removido"
      fi
    done
  fi
  # chaves gravadas direto no ~/.npmrc (npm >= 9 não aceita no config delete)
  for key in strict-ssl always-auth; do
    npmrc_unset "$key" && ok "npmrc $key removido"
  done

  # 3. certificado (só o arquivo que geramos; remove a pasta se ficar vazia)
  if [ -f "$CERT_PATH" ]; then
    rm -f "$CERT_PATH" && ok "Removido $CERT_PATH"
    rmdir "$CERT_DIR" 2>/dev/null && ok "Pasta $CERT_DIR removida (estava vazia)"
  fi

  section "Pronto. Feche e reabra o terminal/VS Code para as variáveis saírem do ambiente."
  exit 0
fi

# =============================================================================
#  MODO APPLY
# =============================================================================

# ----- 0. Credenciais do proxy (RACF) --------------------------------------
if [ -z "$PROXY_URL" ] && [ -n "$PROXY_HOST" ]; then
  section "Proxy corporativo ($PROXY_HOST)"
  printf 'Usuário de rede (RACF): '
  read -r RACF_USER
  if [ -z "$RACF_USER" ]; then
    warn "Usuário vazio — seguindo SEM proxy."
    PROXY_HOST=""
  else
    printf 'Senha (não aparece na tela): '
    stty -echo 2>/dev/null
    read -r RACF_PW
    stty echo 2>/dev/null
    printf '\n'
    PROXY_URL="http://$(urlencode "$RACF_USER"):$(urlencode "$RACF_PW")@$PROXY_HOST"
    RACF_PW=""   # não deixa a senha crua em variável mais que o necessário
    ok "Proxy montado: $(mask_proxy "$PROXY_URL")"
  fi
fi
PROXY_MASK=$(mask_proxy "$PROXY_URL")

# ----- 1. Node/npm (necessários para instalar o portal) --------------------
section "1/4 · Verificando Node.js e npm"
node_v=$(node --version 2>/dev/null | head -1)
if [ -n "$node_v" ]; then ok "node $node_v"; else err "Node.js não encontrado — instale o Node.js (LTS) antes de seguir."; fi
npm_v=$(npm --version 2>/dev/null | head -1)
if [ -n "$npm_v" ]; then ok "npm $npm_v"; else err "npm não encontrado — vem com o Node.js."; fi

# ----- 2. Certificado corporativo + npm (registry/cafile) -------------------
section "2/4 · Certificado corporativo e npm"
mkdir -p "$CERT_DIR"
case "$CERT_PEM" in
  *COLE_AQUI_O_CONTEUDO*)
    if [ -f "$CERT_PATH" ]; then
      warn "PEM não preenchido no script, mas já existe $CERT_PATH — mantendo o existente."
    else
      err "PEM não preenchido e não há $CERT_PATH. Edite o bloco CERT_PEM e rode de novo."
    fi ;;
  *)
    tmp=$(mktemp)
    printf '%s\n' "$CERT_PEM" > "$tmp"
    if [ -f "$CERT_PATH" ] && cmp -s "$tmp" "$CERT_PATH"; then
      ok "Certificado já instalado em $CERT_PATH"
    else
      cp "$tmp" "$CERT_PATH" && chmod 644 "$CERT_PATH" && ok "Certificado gravado em $CERT_PATH"
    fi
    rm -f "$tmp" ;;
esac
if command -v npm >/dev/null 2>&1; then
  if [ -n "$REGISTRY_URL" ]; then
    npm config set registry "$REGISTRY_URL" && ok "registry: $REGISTRY_URL"
  else
    warn "REGISTRY_URL vazio — registry npm não alterado."
  fi
  [ -f "$CERT_PATH" ] && npm config set cafile "$CERT_PATH_NATIVE" && ok "cafile: $CERT_PATH_NATIVE"
  # proxy corporativo reassina o TLS e o Artifactory exige auth em toda rota —
  # sem estas duas linhas o npm install falha (SELF_SIGNED_CERT / 401)
  npmrc_set strict-ssl false && ok "strict-ssl=false"
  npmrc_set always-auth true && ok "always-auth=true"
  echo "  (as linhas extras de auth do registry você cola no ~/.npmrc à mão)"
else
  warn "npm não encontrado — pulei a configuração de registry."
fi

# ----- 3. uv (gerenciador Python do MCP ConsumerLab) -----------------------
section "3/4 · uv (gerenciador Python)"
UV_DIR=""
if [ "$INSTALL_UV" != "1" ]; then
  warn "INSTALL_UV=0 — pulei a instalação do uv."
else
  # exporta proxy/CA NESTA sessão para o pip/instalador alcançarem a rede
  if [ -f "$CERT_PATH" ]; then
    export NODE_EXTRA_CA_CERTS="$CERT_PATH_NATIVE" SSL_CERT_FILE="$CERT_PATH_NATIVE"
    export REQUESTS_CA_BUNDLE="$CERT_PATH_NATIVE" PIP_CERT="$CERT_PATH_NATIVE"
    export CURL_CA_BUNDLE="$CERT_PATH"
  fi
  [ -n "$PROXY_URL" ] && export HTTPS_PROXY="$PROXY_URL" HTTP_PROXY="$PROXY_URL"

  uv_ver=$(uv --version 2>/dev/null | head -1)
  if [ -n "$uv_ver" ]; then
    UV_DIR=$(dirname "$(command -v uv)")
    ok "uv já instalado: $uv_ver"
  else
    UV_DIR=$(find_uv_dir)   # já instalado fora do PATH (pip/instalador)?
    if [ -z "$UV_DIR" ]; then
      echo "  uv não encontrado — instalando com pip (--user)…"
      for _py in python3 python py; do
        command -v "$_py" >/dev/null 2>&1 || continue
        "$_py" -m pip install --user --upgrade uv && break
        # proxy corporativo que reassina o TLS derruba o pip mesmo com PIP_CERT
        # (cadeia incompleta é comum) — repete confiando nos hosts do PyPI
        echo "  pip falhou — tentando de novo com --trusted-host (TLS do proxy)…"
        "$_py" -m pip install --user --upgrade \
          --trusted-host pypi.org --trusted-host files.pythonhosted.org uv && break
      done
      UV_DIR=$(find_uv_dir)
    fi
    # instalador oficial via curl: funciona TAMBÉM no Git Bash (o install.sh
    # detecta MINGW/MSYS e baixa o binário windows) — nunca usa PowerShell,
    # que costuma ser bloqueado pelo antivírus corporativo
    if [ -z "$UV_DIR" ] && command -v curl >/dev/null 2>&1; then
      echo "  pip não resolveu — tentando o instalador oficial (astral.sh)…"
      curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh || true
      UV_DIR=$(find_uv_dir)
    fi
    if [ -n "$UV_DIR" ]; then
      PATH="$UV_DIR:$PATH"; export PATH
      uv_ver=$(uv --version 2>/dev/null | head -1)
      ok "uv pronto em $UV_DIR${uv_ver:+ ($uv_ver)}"
    else
      warn "Não consegui instalar o uv (pip/Python indisponível?). O portal tenta de novo depois."
    fi
  fi
fi

# ----- 4. Variáveis de ambiente --------------------------------------------
section "4/4 · Variáveis de ambiente"
if [ "$IS_WINDOWS" -eq 1 ]; then
  # Windows/Git Bash: grava no REGISTRO do usuário (o portal lê dali via
  # resolveWindowsEnv). setx persiste; só vale em processos abertos DEPOIS.
  setx NODE_EXTRA_CA_CERTS          "$CERT_PATH_NATIVE" >/dev/null && ok "NODE_EXTRA_CA_CERTS=$CERT_PATH_NATIVE"
  setx NODE_TLS_REJECT_UNAUTHORIZED "0"                 >/dev/null && ok "NODE_TLS_REJECT_UNAUTHORIZED=0"
  setx SSL_CERT_FILE                "$CERT_PATH_NATIVE" >/dev/null && ok "SSL_CERT_FILE"
  setx REQUESTS_CA_BUNDLE           "$CERT_PATH_NATIVE" >/dev/null && ok "REQUESTS_CA_BUNDLE"
  setx AWS_CA_BUNDLE                "$CERT_PATH_NATIVE" >/dev/null && ok "AWS_CA_BUNDLE"
  if [ -n "$PROXY_URL" ]; then
    setx HTTPS_PROXY "$PROXY_URL"     >/dev/null && ok "HTTPS_PROXY (senha mascarada: $PROXY_MASK)"
    setx HTTP_PROXY  "$PROXY_URL"     >/dev/null && ok "HTTP_PROXY"
    setx NO_PROXY    "$NO_PROXY_LIST" >/dev/null && ok "NO_PROXY"
  fi
  # uv no PATH do usuário (registro, lido+reescrito — não usa setx, que trunca)
  if [ -n "$UV_DIR" ]; then
    UV_DIR_WIN=$(cygpath -w "$UV_DIR" 2>/dev/null || printf '%s' "$UV_DIR")
    _dq=$(printf '%s' "$UV_DIR_WIN" | sed "s/'/''/g")
    if powershell -NoProfile -ExecutionPolicy Bypass -Command "\$d='$_dq'; \$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not \$p){\$p=''}; \$parts=@(\$p -split ';' | Where-Object { \$_ }); if(\$parts -notcontains \$d){ [Environment]::SetEnvironmentVariable('Path', ((@(\$d)+\$parts) -join ';'),'User') }" >/dev/null 2>&1; then
      ok "uv no PATH do usuário: $UV_DIR_WIN"
    else
      # PowerShell bloqueado (antivírus corporativo)? reg.exe faz o mesmo
      _cur=""
      if reg query "HKCU\\Environment" /v Path >/dev/null 2>&1; then
        _cur=$(reg query "HKCU\\Environment" /v Path 2>/dev/null | sed -n 's/.*REG_\(EXPAND_\)\{0,1\}SZ[[:space:]]*//p' | tr -d '\r' | head -1)
        # Path existe mas não deu para ler o valor → NÃO sobrescreve às cegas
        [ -z "$_cur" ] && { warn "Não consegui ler o Path do registro — uv fica só nesta sessão (o portal persiste na abertura)."; UV_DIR_WIN=""; }
      fi
      if [ -n "$UV_DIR_WIN" ]; then
        case ";$_cur;" in
          *";$UV_DIR_WIN;"*) ok "uv já estava no PATH do usuário: $UV_DIR_WIN" ;;
          *)
            if reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "$UV_DIR_WIN${_cur:+;$_cur}" /f >/dev/null 2>&1; then
              ok "uv no PATH do usuário (via reg.exe): $UV_DIR_WIN"
            else
              warn "Não consegui persistir o uv no PATH — o portal tenta de novo na abertura."
            fi ;;
        esac
      fi
    fi
  fi
else
  # POSIX (mac/linux): bloco gerenciado no rc do shell
  BLOCK=$(
    printf '%s\n' "$BLOCK_BEGIN"
    printf '%s\n' "# gerado por bootstrap-itau.sh — não edite à mão (use --undo para remover)"
    printf '%s\n' "export NODE_EXTRA_CA_CERTS=\"$CERT_PATH\""
    printf '%s\n' "export NODE_TLS_REJECT_UNAUTHORIZED=0   # (desativa validação TLS do Node)"
    printf '%s\n' "export SSL_CERT_FILE=\"$CERT_PATH\""
    printf '%s\n' "export REQUESTS_CA_BUNDLE=\"$CERT_PATH\""
    printf '%s\n' "export AWS_CA_BUNDLE=\"$CERT_PATH\""
    if [ -n "$PROXY_URL" ]; then
      printf '%s\n' "export HTTPS_PROXY=\"$PROXY_URL\""
      printf '%s\n' "export HTTP_PROXY=\"$PROXY_URL\""
      printf '%s\n' "export https_proxy=\"$PROXY_URL\""
      printf '%s\n' "export http_proxy=\"$PROXY_URL\""
      printf '%s\n' "export NO_PROXY=\"$NO_PROXY_LIST\""
      printf '%s\n' "export no_proxy=\"$NO_PROXY_LIST\""
    fi
    # deixa o uv no PATH de forma permanente (o portal também garante isso)
    [ -n "$UV_DIR" ] && printf '%s\n' "export PATH=\"$UV_DIR:\$PATH\""
    printf '%s\n' "$BLOCK_END"
  )
  rc_targets_apply | sort -u | while IFS= read -r f; do
    [ -n "$f" ] || continue
    strip_block "$f"                       # remove versão anterior (idempotente)
    printf '%s\n' "$BLOCK" >> "$f"
    ok "Variáveis gravadas em $f"
  done
fi

section "Concluído."
warn "NODE_TLS_REJECT_UNAUTHORIZED=0 desativa a verificação de TLS do Node."
if [ -n "$PROXY_URL" ]; then
  warn "A senha do proxy fica em TEXTO PURO no ambiente/npm. Quando o RACF expirar,"
  warn "rode 'sh $0 --undo' e aplique de novo com a senha nova."
fi
printf '\n%s\n' "Agora ${C_BLD}feche e reabra o terminal e o VS Code${C_RST} para recarregar o ambiente."
printf '%s\n' "Instale o portal e abra-o no browser: a tela de Diagnóstico verifica o restante"
printf '%s\n' "(git, python, AWS CLI e conectividade) e mostra o que falta regularizar."
printf '%s\n' "Para reverter tudo: ${C_BLD}sh $0 --undo${C_RST}"
