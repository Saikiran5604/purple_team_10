const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
let helmet;
try { helmet = require('helmet'); } catch { helmet = null; }

const InfraGraph = require('./graph');
const CascadePredictor = require('./cascade-predictor');
const InfraSimulator = require('./simulator');

const infraData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'infrastructure.json'), 'utf8'));

const graph = new InfraGraph(infraData);
const predictor = new CascadePredictor(graph, infraData);
const simulator = new InfraSimulator(graph);

if (graph.hasCycle()) {
  console.warn('WARNING: Infrastructure graph contains cycles!');
}

const app = express();
if (helmet) app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/graph', (req, res) => {
  res.json(graph.getGraphData());
});

app.post('/api/predict', (req, res) => {
  const { failedNodes, timeHorizon, weather, timeOfDay } = req.body;
  if (!failedNodes || !Array.isArray(failedNodes) || failedNodes.length === 0) {
    return res.status(400).json({ error: 'failedNodes array required' });
  }
  if (failedNodes.length > 15) {
    return res.status(400).json({ error: 'failedNodes limited to 15 nodes' });
  }
  const validWeather = ['clear', 'rain', 'storm', 'extreme_heat', 'flood'];
  const safeWeather = validWeather.includes(weather) ? weather : 'clear';
  const safeTime = Number.isFinite(timeOfDay) && timeOfDay >= 0 && timeOfDay <= 23 ? timeOfDay : new Date().getHours();
  const result = predictor.predictCascade(failedNodes, {
    timeHorizonHours: Math.min(Math.max(timeHorizon || 4, 1), 48),
    weather: safeWeather,
    timeOfDay: safeTime
  });
  res.json(result);
});

app.get('/api/risk-assessment', (req, res) => {
  res.json(predictor.assessRisk());
});

app.get('/api/historical', (req, res) => {
  res.json(predictor.getHistoricalStats());
});

app.get('/api/historical/timeline', (req, res) => {
  res.json(predictor.getHistoricalTimeline());
});

app.get('/api/historical/heatmap', (req, res) => {
  res.json(predictor.getHourlyHeatmap());
});

app.get('/api/historical/categories', (req, res) => {
  res.json(predictor.getCategoryStats());
});

app.get('/api/context-options', (req, res) => {
  res.json({
    weather: predictor.getWeatherOptions(),
    time: predictor.getTimeOptions()
  });
});

app.post('/api/mitigate', (req, res) => {
  const { nodeId, mitigationId } = req.body;
  if (!nodeId || !mitigationId) {
    return res.status(400).json({ error: 'nodeId and mitigationId required' });
  }
  if (!graph.hasNode(nodeId)) {
    return res.status(404).json({ error: `Unknown node: ${nodeId}` });
  }

  const node = graph.getNode(nodeId);
  const options = node.mitigation_options || [];
  const mitigation = options.find(o => o.id === mitigationId);
  if (!mitigation) {
    return res.status(404).json({ error: `Unknown mitigation: ${mitigationId} for node ${nodeId}` });
  }

  const result = simulator.applyMitigation(nodeId, mitigation.effectiveness);
  if (result.error) {
    return res.status(400).json(result);
  }

  res.json({
    success: true,
    mitigation: {
      id: mitigation.id,
      name: mitigation.name,
      type: mitigation.type,
      effectiveness: mitigation.effectiveness,
      time_minutes: mitigation.time_minutes,
      description: mitigation.description
    },
    updatedStatus: result.status,
    event: result.event
  });
});

let lastTickTime = 0;
app.get('/api/status', (req, res) => {
  const now = Date.now();
  if (now - lastTickTime >= 2000) {
    simulator.simulateTick();
    lastTickTime = now;
  }
  res.json(simulator.getStatus());
});

app.post('/api/simulate/tick', (req, res) => {
  simulator.simulateTick();
  res.json(simulator.getStatus());
});

app.get('/api/failed', (req, res) => {
  res.json(simulator.getFailedNodes());
});

app.post('/api/simulate/failure', (req, res) => {
  const { nodeId } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'nodeId required' });
  if (!graph.hasNode(nodeId)) return res.status(404).json({ error: `Unknown node: ${nodeId}` });

  const result = simulator.triggerFailure(nodeId);
  if (result.error && result.error !== 'already_failed') {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post('/api/simulate/restore', (req, res) => {
  res.json(simulator.restoreAll());
});

app.post('/api/simulate/restore/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  if (!graph.hasNode(nodeId)) return res.status(404).json({ error: `Unknown node: ${nodeId}` });
  res.json(simulator.restoreNode(nodeId));
});

app.get('/api/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(simulator.getEventLog(Math.min(limit, 200)));
});

app.get('/api/scenarios', (req, res) => {
  res.json(infraData.scenarios);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  InfraPulse Server running at http://localhost:${PORT}\n`);
});
