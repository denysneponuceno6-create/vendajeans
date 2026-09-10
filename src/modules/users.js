"use strict";
/* ============================================================
   USUÁRIOS E PERFIS
   Substitui o par único ADMIN_USER/ADMIN_PASS do servidor antigo.
   Agora cada pessoa tem login próprio — sem isso a auditoria não
   significa nada, porque tudo aparecia como "admin".
============================================================ */
const db = require("../db/pool");
const v = require("../core/validate");
const auth = require("../core/auth");
const auditoria = require("../core/audit");
const { ErroHttp } = require("../core/http");

const PERFIS = Object.keys(auth.PERMISSOES);
const PUBLICO = `id, usuario, nome, email, perfil, ativo, totp_ativo,
                 ultimo_login, bloqueado_ate, criado_em`;

async function listar() {
  return db.todos(
    `SELECT ${PUBLICO},
            (SELECT count(*)::int FROM sessions s
              WHERE s.user_id = users.id AND s.revogada_em IS NULL
                AND s.expira_em > now()) AS sessoes_ativas
       FROM users ORDER BY ativo DESC, usuario`);
}

async function porId(id) {
  const u = await db.um(`SELECT ${PUBLICO} FROM users WHERE id=$1`, [id]);
  if (!u) throw new ErroHttp(404, "usuário não encontrado");
  u.permissoes = auth.permissoesDe(u.perfil);
  return u;
}

async function criar(corpo, ctx) {
  const usuario = v.texto(corpo.usuario, { campo: "usuário", max: 40, min: 3, obrigatorio: true })
    .toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (usuario.length < 3) throw new ErroHttp(400, "usuário inválido (use letras, números, ponto ou hífen)");

  const nome = v.texto(corpo.nome, { campo: "nome", max: 120, obrigatorio: true });
  const perfil = v.opcao(corpo.perfil, PERFIS, { padrao: "visualizacao", campo: "perfil" });
  const email = corpo.email ? v.email(corpo.email) : null;
  const senha = String(corpo.senha || "");
  const problema = auth.forcaSenha(senha);
  if (problema) throw new ErroHttp(400, problema);

  const existe = await db.um("SELECT id FROM users WHERE usuario=$1", [usuario]);
  if (existe) throw new ErroHttp(409, "já existe usuário com esse login");

  const u = await db.um(
    `INSERT INTO users (usuario, nome, email, senha_hash, perfil, ativo)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING ${PUBLICO}`,
    [usuario, nome, email, await auth.hashSenhaAsync(senha), perfil]);

  await auditoria.registrar(ctx, {
    acao: "usuario.criado", recurso: "users", recursoId: u.id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " criou o usuário " +
      usuario + " com perfil " + perfil,
    depois: { usuario, perfil, nome }
  });
  return u;
}

async function atualizar(id, corpo, ctx) {
  const atual = await db.um("SELECT * FROM users WHERE id=$1", [id]);
  if (!atual) throw new ErroHttp(404, "usuário não encontrado");

  const d = {};
  if (corpo.nome !== undefined) d.nome = v.texto(corpo.nome, { campo: "nome", max: 120, obrigatorio: true });
  if (corpo.email !== undefined) d.email = corpo.email ? v.email(corpo.email) : null;
  if (corpo.perfil !== undefined) d.perfil = v.opcao(corpo.perfil, PERFIS, { campo: "perfil" });
  if (corpo.ativo !== undefined) d.ativo = v.booleano(corpo.ativo, true);

  /* Trava de segurança: o sistema não pode ficar sem administrador. */
  if ((d.perfil && d.perfil !== "administrador" && atual.perfil === "administrador") ||
      (d.ativo === false && atual.perfil === "administrador")) {
    const outros = await db.um(
      "SELECT count(*)::int AS n FROM users WHERE perfil='administrador' AND ativo AND id<>$1", [id]);
    if (outros.n === 0) {
      throw new ErroHttp(400, "este é o último administrador ativo — promova outro antes de mudar este");
    }
  }
  if (!Object.keys(d).length) return porId(id);

  const campos = Object.keys(d);
  const sets = campos.map((c, i) => c + " = $" + (i + 2));
  const u = await db.um(
    `UPDATE users SET ${sets.join(", ")}, atualizado_em=now() WHERE id=$1 RETURNING ${PUBLICO}`,
    [id, ...campos.map(c => d[c])]);

  /* Mudou perfil ou desativou: as sessões abertas precisam cair,
     senão a permissão antiga continua valendo até o cookie expirar. */
  if (d.perfil !== undefined || d.ativo === false) {
    await auth.revogarTodasDoUsuario(id, null);
  }

  const dif = auditoria.diferenca(atual, u, campos);
  await auditoria.registrar(ctx, {
    acao: "usuario.atualizado", recurso: "users", recursoId: id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " alterou " +
      dif.campos.join(", ") + " do usuário " + atual.usuario,
    antes: dif.de, depois: dif.para
  });
  return u;
}

async function trocarSenha(id, corpo, ctx, { exigirAtual }) {
  const u = await db.um("SELECT * FROM users WHERE id=$1", [id]);
  if (!u) throw new ErroHttp(404, "usuário não encontrado");

  if (exigirAtual) {
    if (!await auth.conferirSenhaAsync(String(corpo.senha_atual || ""), u.senha_hash)) {
      throw new ErroHttp(400, "senha atual incorreta");
    }
  }
  const nova = String(corpo.senha_nova || corpo.senha || "");
  const problema = auth.forcaSenha(nova);
  if (problema) throw new ErroHttp(400, problema);
  if (await auth.conferirSenhaAsync(nova, u.senha_hash)) throw new ErroHttp(400, "a nova senha é igual à atual");

  await db.query("UPDATE users SET senha_hash=$2, atualizado_em=now() WHERE id=$1",
    [id, await auth.hashSenhaAsync(nova)]);
  /* Derruba as outras sessões: se a senha vazou, trocar a senha
     precisa expulsar quem estava dentro. */
  await auth.revogarTodasDoUsuario(id, ctx.sessao ? ctx.sessao.sessaoId : null);

  await auditoria.registrar(ctx, {
    acao: "usuario.senha_alterada", recurso: "users", recursoId: id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " alterou a senha de " + u.usuario +
      ". Demais sessões foram revogadas."
  });
  return { ok: true };
}

/* ---------- 2FA ---------- */
async function iniciar2fa(id, ctx) {
  const u = await db.um("SELECT usuario, totp_ativo FROM users WHERE id=$1", [id]);
  if (!u) throw new ErroHttp(404, "usuário não encontrado");
  if (u.totp_ativo) throw new ErroHttp(400, "o 2FA já está ativo nesta conta");
  const segredo = auth.gerarSegredoTotp();
  await db.query("UPDATE users SET totp_secret=$2 WHERE id=$1", [id, segredo]);
  return {
    segredo,
    url: auth.urlTotp(u.usuario, segredo),
    instrucao: "Abra o app autenticador, escaneie ou digite o segredo e confirme com o código de 6 dígitos."
  };
}

async function confirmar2fa(id, codigo, ctx) {
  const u = await db.um("SELECT usuario, totp_secret FROM users WHERE id=$1", [id]);
  if (!u || !u.totp_secret) throw new ErroHttp(400, "inicie a configuração do 2FA primeiro");
  if (!auth.conferirTotp(u.totp_secret, codigo)) throw new ErroHttp(400, "código inválido");
  await db.query("UPDATE users SET totp_ativo=true, atualizado_em=now() WHERE id=$1", [id]);
  await auditoria.registrar(ctx, {
    acao: "usuario.2fa_ativado", recurso: "users", recursoId: id,
    descricao: "2FA ativado para o usuário " + u.usuario
  });
  return { ok: true };
}

async function desativar2fa(id, ctx) {
  const u = await db.um("SELECT usuario FROM users WHERE id=$1", [id]);
  if (!u) throw new ErroHttp(404, "usuário não encontrado");
  await db.query("UPDATE users SET totp_ativo=false, totp_secret=NULL, atualizado_em=now() WHERE id=$1", [id]);
  await auditoria.registrar(ctx, {
    acao: "usuario.2fa_desativado", recurso: "users", recursoId: id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " desativou o 2FA de " + u.usuario
  });
  return { ok: true };
}

/* ---------- sessões ---------- */
async function sessoes(userId) {
  return db.todos(
    `SELECT id, criada_em, expira_em, ultimo_uso, ip, user_agent, revogada_em
       FROM sessions WHERE user_id=$1 ORDER BY criada_em DESC LIMIT 50`, [userId]);
}

async function revogarSessao(sessaoId, ctx) {
  await auth.revogarSessao(sessaoId);
  await auditoria.registrar(ctx, {
    acao: "sessao.revogada", recurso: "sessions", recursoId: sessaoId,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " revogou uma sessão"
  });
  return { ok: true };
}

async function revogarTudo(userId, ctx) {
  await auth.revogarTodasDoUsuario(userId, null);
  await auditoria.registrar(ctx, {
    acao: "sessao.revogada_todas", recurso: "users", recursoId: userId,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") +
      " revogou todas as sessões do usuário " + userId
  });
  return { ok: true };
}

/* ---------- login ---------- */
const MAX_FALHAS = 5;
const BLOQUEIO_MIN = 15;

async function autenticar(usuario, senha, codigo2fa, req, ctx) {
  const login = String(usuario || "").toLowerCase().slice(0, 40);
  const u = await db.um("SELECT * FROM users WHERE usuario=$1", [login]);

  /* Mesmo sem usuário, gastamos tempo comparando: evita descobrir
     logins válidos pela diferença de tempo de resposta. */
  const hashFalso = "pbkdf2$210000$00$00";
  if (!u) {
    await auth.conferirSenhaAsync(senha, hashFalso);
    throw new ErroHttp(401, "usuário ou senha incorretos");
  }

  /* A senha é conferida ANTES de qualquer resposta específica.

     A versão anterior respondia 403 "usuário desativado" e 429
     "conta bloqueada" antes de olhar a senha — o que transformava
     o login num verificador de logins válidos: bastava tentar
     qualquer senha e ler o código de status. Agora quem não sabe a
     senha recebe sempre o mesmo 401 genérico, e só quem prova
     conhecer a senha descobre que a conta existe mas está
     desativada ou bloqueada. */
  const senhaConfere = await auth.conferirSenhaAsync(senha, u.senha_hash);

  if (u.bloqueado_ate && new Date(u.bloqueado_ate).getTime() > Date.now()) {
    if (!senhaConfere) throw new ErroHttp(401, "usuário ou senha incorretos");
    const min = Math.ceil((new Date(u.bloqueado_ate).getTime() - Date.now()) / 60000);
    throw new ErroHttp(429, "conta bloqueada por tentativas. Aguarde " + min + " minuto(s).");
  }
  if (!u.ativo) {
    if (!senhaConfere) throw new ErroHttp(401, "usuário ou senha incorretos");
    throw new ErroHttp(403, "usuário desativado");
  }

  if (!senhaConfere) {
    const falhas = u.falhas_login + 1;
    const bloqueio = falhas >= MAX_FALHAS ? new Date(Date.now() + BLOQUEIO_MIN * 60000) : null;
    await db.query("UPDATE users SET falhas_login=$2, bloqueado_ate=$3 WHERE id=$1",
      [u.id, falhas, bloqueio]);
    await auditoria.registrar({ ip: ctx.ip }, {
      acao: "login.falhou", recurso: "users", recursoId: u.id, usuario: login,
      descricao: "Tentativa de login incorreta para " + login +
        (bloqueio ? " — conta bloqueada por " + BLOQUEIO_MIN + " minutos" : "")
    });
    throw new ErroHttp(401, "usuário ou senha incorretos");
  }

  if (u.totp_ativo) {
    if (!codigo2fa) throw new ErroHttp(401, "informe o código do autenticador", { precisa2fa: true });
    if (!auth.conferirTotp(u.totp_secret, codigo2fa)) {
      await auditoria.registrar({ ip: ctx.ip }, {
        acao: "login.2fa_falhou", recurso: "users", recursoId: u.id, usuario: login,
        descricao: "Código 2FA incorreto para " + login
      });
      throw new ErroHttp(401, "código do autenticador incorreto", { precisa2fa: true });
    }
  }

  await db.query(
    "UPDATE users SET falhas_login=0, bloqueado_ate=NULL, ultimo_login=now() WHERE id=$1", [u.id]);
  const sessao = await auth.criarSessao(u.id, req);

  await auditoria.registrar({ ip: ctx.ip, sessao: { userId: u.id, usuario: u.usuario } }, {
    acao: "login.sucesso", recurso: "users", recursoId: u.id,
    descricao: u.usuario + " entrou no sistema"
  });

  return {
    token: sessao.token,
    usuario: {
      id: u.id, usuario: u.usuario, nome: u.nome, perfil: u.perfil,
      permissoes: auth.permissoesDe(u.perfil), totpAtivo: u.totp_ativo
    }
  };
}

module.exports = {
  PERFIS, listar, porId, criar, atualizar, trocarSenha,
  iniciar2fa, confirmar2fa, desativar2fa,
  sessoes, revogarSessao, revogarTudo, autenticar
};
