const { validateAgentName } = require('../agent-security');
const {
  listAgents,
  readAgent,
  writeAgent,
  renameAgent,
  deleteAgent,
  agentExists,
} = require('../agents');
const {
  sendJson,
  sendError,
  readBody,
  decodeSeg,
  mapError,
} = require('./helpers');

async function handleAgentsApi(req, res, pathname, method) {
  if (method === 'GET' && pathname === '/api/agents') {
    try {
      sendJson(res, 200, listAgents());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/agents') {
    try {
      const body = await readBody(req);
      const name = body && body.name;
      if (!name) return sendError(res, 400, 'name is required'), true;
      if (!validateAgentName(name)) return sendError(res, 400, 'invalid agent name'), true;
      if (agentExists(name)) return sendError(res, 409, 'Agent already exists'), true;
      writeAgent(
        name,
        {
          description: body.description,
          category: body.category,
          tools: body.tools,
          model: body.model,
          thinking: body.thinking,
          taskType: body.taskType,
          systemPromptMode: body.systemPromptMode,
          inheritProjectContext: body.inheritProjectContext,
          inheritSkills: body.inheritSkills,
          fallbackModels: body.fallbackModels,
        },
        body.prompt || ''
      );
      sendJson(res, 201, { ok: true, name });
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  if (pathname.startsWith('/api/agents/')) {
    const rest = pathname.slice('/api/agents/'.length);
    if (!rest || rest.includes('/')) return false;
    const name = decodeSeg(rest);
    if (name == null) return sendError(res, 400, 'invalid agent name'), true;

    if (method === 'GET') {
      try {
        sendJson(res, 200, readAgent(name));
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        readAgent(name);
        const newName = (body.name || name).trim();
        if (!validateAgentName(newName)) return sendError(res, 400, 'invalid new name'), true;
        const fields = {
          description: body.description,
          category: body.category,
          tools: body.tools,
          model: body.model,
          thinking: body.thinking,
          taskType: body.taskType,
          systemPromptMode: body.systemPromptMode,
          inheritProjectContext: body.inheritProjectContext,
          inheritSkills: body.inheritSkills,
          fallbackModels: body.fallbackModels,
        };
        const prompt = body.prompt || '';
        if (newName !== name) renameAgent(name, newName, fields, prompt);
        else writeAgent(name, fields, prompt);
        sendJson(res, 200, { ok: true, name: newName });
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
    if (method === 'DELETE') {
      try {
        deleteAgent(name);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }
  return false;
}

module.exports = { handleAgentsApi };
