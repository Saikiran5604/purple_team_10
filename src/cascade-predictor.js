const { seededRandom } = require('./utils');

const WEATHER_MULTIPLIERS = {
  clear: 1.0,
  rain: 1.3,
  storm: 1.7,
  extreme_heat: 1.4,
  flood: 2.0
};

const TIME_MULTIPLIERS = {
  night: 0.7,
  morning_peak: 1.5,
  midday: 1.0,
  evening_peak: 1.6,
  late_evening: 0.8
};

function getTimePeriod(hour) {
  if (hour >= 0 && hour < 6) return 'night';
  if (hour >= 6 && hour < 10) return 'morning_peak';
  if (hour >= 10 && hour < 16) return 'midday';
  if (hour >= 16 && hour < 20) return 'evening_peak';
  return 'late_evening';
}

const OUTDOOR_CATEGORIES = new Set(['electricity', 'water', 'roads']);
const CITY_POPULATION_CAP = 2100000;

class CascadePredictor {
  constructor(graph) {
    this.graph = graph;
    this.rng = seededRandom(123);
    this.historicalFailures = this.generateHistoricalData();
    this.conditionalProbabilities = this.trainModel();
  }

  generateHistoricalData() {
    const incidents = [];
    const scenarios = [
      { trigger: 'power_grid', cascades: ['power_substation_a', 'power_substation_b', 'water_pump_station', 'mobile_tower_cluster_a', 'mobile_tower_cluster_b', 'traffic_signals_north', 'traffic_signals_south', 'telecom_data_center', 'traffic_control_center'], freq: 12 },
      { trigger: 'power_substation_a', cascades: ['water_pump_station', 'mobile_tower_cluster_a', 'traffic_signals_north', 'traffic_control_center', 'hospital_north'], freq: 24 },
      { trigger: 'power_substation_b', cascades: ['mobile_tower_cluster_b', 'traffic_signals_south', 'telecom_data_center', 'hospital_south'], freq: 18 },
      { trigger: 'water_treatment', cascades: ['water_pump_station'], freq: 8 },
      { trigger: 'telecom_data_center', cascades: ['mobile_tower_cluster_a', 'mobile_tower_cluster_b', 'emergency_services'], freq: 6 },
      { trigger: 'water_pump_station', cascades: ['hospital_north', 'hospital_south'], freq: 10 },
      { trigger: 'traffic_control_center', cascades: ['traffic_signals_north', 'traffic_signals_south'], freq: 15 },
      { trigger: 'water_reservoir', cascades: ['water_treatment', 'water_pump_station'], freq: 4 },
    ];

    const weathers = ['clear', 'clear', 'clear', 'rain', 'storm', 'extreme_heat', 'flood'];
    const hours = [2, 7, 8, 12, 14, 17, 18, 19, 22];

    for (const s of scenarios) {
      for (let i = 0; i < s.freq; i++) {
        const affected = [s.trigger];
        for (const c of s.cascades) {
          if (this.rng() < 0.7 + this.rng() * 0.25) affected.push(c);
        }

        const weather = weathers[Math.floor(this.rng() * weathers.length)];
        const hour = hours[Math.floor(this.rng() * hours.length)];

        incidents.push({
          timestamp: Date.now() - this.rng() * 365 * 24 * 3600000,
          trigger: s.trigger,
          affected,
          duration: this.rng() * 8 + 1,
          severity: affected.length > 5 ? 'critical' : affected.length > 3 ? 'high' : 'medium',
          weather,
          hour,
          timePeriod: getTimePeriod(hour),
          dayOfWeek: Math.floor(this.rng() * 7)
        });
      }
    }
    return incidents;
  }

  trainModel() {
    const coOccurrence = {};
    const nodeCount = {};

    for (const incident of this.historicalFailures) {
      for (const a of incident.affected) {
        nodeCount[a] = (nodeCount[a] || 0) + 1;
        for (const b of incident.affected) {
          if (a !== b) {
            const key = `${a}|${b}`;
            coOccurrence[key] = (coOccurrence[key] || 0) + 1;
          }
        }
      }
    }

    const conditionalProbs = {};
    for (const key of Object.keys(coOccurrence)) {
      const [a] = key.split('|');
      conditionalProbs[key] = coOccurrence[key] / (nodeCount[a] || 1);
    }

    return conditionalProbs;
  }

  predictCascade(failedNodeIds, options = {}) {
    const {
      timeHorizonHours = 4,
      weather = 'clear',
      timeOfDay = new Date().getHours()
    } = options;

    const validIds = failedNodeIds.filter(id => this.graph.hasNode(id));
    if (validIds.length === 0) return { predictions: [], summary: this.emptySummary(failedNodeIds), mitigations: [] };

    const timePeriod = getTimePeriod(timeOfDay);
    const weatherMult = WEATHER_MULTIPLIERS[weather] || 1.0;
    const timeMult = TIME_MULTIPLIERS[timePeriod] || 1.0;

    const predictions = new Map();
    const visited = new Set(validIds);

    for (const id of validIds) {
      predictions.set(id, { probability: 1.0, depth: 0, path: [id], timeToImpact: 0 });
    }

    const queue = [...validIds.map(id => ({ id, depth: 0 }))];

    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (depth > 10) continue;

      const downstream = this.graph.getDependencies(id);

      for (const dep of downstream) {
        const targetNode = this.graph.getNode(dep.target);
        if (!targetNode) continue;

        const edgeWeight = dep.weight;
        const parentProb = predictions.get(id).probability;

        const histKey = `${id}|${dep.target}`;
        const historicalProb = this.conditionalProbabilities[histKey] || 0;

        let graphProb = parentProb * edgeWeight;
        let mlProb = historicalProb;

        if (OUTDOOR_CATEGORIES.has(targetNode.category)) {
          graphProb *= weatherMult;
          mlProb *= weatherMult;
        }
        graphProb *= timeMult;
        mlProb *= timeMult;

        if (targetNode.hasBackupPower && dep.type === 'powers') {
          graphProb *= 0.35;
          mlProb *= 0.4;
        }

        const combinedProb = 0.4 * graphProb + 0.6 * mlProb;
        const finalProb = Math.min(combinedProb, 0.99);

        const baseTime = (depth + 1) * 0.8;
        const timeToImpact = targetNode.hasBackupPower ? baseTime + 2.0 : baseTime;

        const existing = predictions.get(dep.target);
        if (!existing || existing.probability < finalProb) {
          const parentPath = predictions.get(id).path;
          predictions.set(dep.target, {
            probability: parseFloat(finalProb.toFixed(3)),
            depth: depth + 1,
            path: [...parentPath, dep.target],
            timeToImpact: parseFloat(timeToImpact.toFixed(1)),
            edgeType: dep.type,
            fromNode: id
          });
        }

        if (!visited.has(dep.target) && finalProb > 0.05) {
          visited.add(dep.target);
          queue.push({ id: dep.target, depth: depth + 1 });
        }
      }
    }

    return this.formatPredictions(predictions, validIds, { weather, timePeriod, weatherMult, timeMult });
  }

  calculateDeduplicatedPopulation(affectedResults) {
    let total = 0;
    const counted = new Set();
    for (const r of affectedResults) {
      if (counted.has(r.nodeId)) continue;
      counted.add(r.nodeId);
      const node = this.graph.getNode(r.nodeId);
      if (node) {
        total += node.population_affected || 0;
      }
    }
    return Math.min(total, CITY_POPULATION_CAP);
  }

  calculateRevenueImpact(affectedResults) {
    let totalPerHour = 0;
    for (const r of affectedResults) {
      const node = this.graph.getNode(r.nodeId);
      if (node && node.revenue_per_hour) {
        totalPerHour += node.revenue_per_hour * r.probability;
      }
    }
    return {
      perHour: Math.round(totalPerHour),
      projected4h: Math.round(totalPerHour * 4),
      projected24h: Math.round(totalPerHour * 24)
    };
  }

  generateMitigations(predictions, triggerIds) {
    const candidates = [];

    for (const [nodeId, pred] of predictions) {
      if (pred.probability <= 0.3 && !triggerIds.includes(nodeId)) continue;

      const node = this.graph.getNode(nodeId);
      if (!node || !node.mitigation_options) continue;

      const revenue = node.revenue_per_hour || 0;

      for (const opt of node.mitigation_options) {
        const score = opt.effectiveness * pred.probability * (revenue / 100000);
        const savings = Math.round(revenue * opt.effectiveness * pred.probability);

        let priority;
        if (score > 3) priority = 'critical';
        else if (score > 1) priority = 'high';
        else priority = 'medium';

        candidates.push({
          id: opt.id,
          action: opt.name,
          targetNode: node.name,
          targetNodeId: nodeId,
          type: opt.type,
          effectiveness: opt.effectiveness,
          time_minutes: opt.time_minutes,
          description: opt.description,
          estimatedSavingsPerHour: savings,
          priority,
          score
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 8).map(({ score, ...rest }) => rest);
  }

  formatPredictions(predictions, triggerIds, context = {}) {
    const results = [];
    for (const [nodeId, pred] of predictions) {
      const node = this.graph.getNode(nodeId);
      if (!node) continue;
      results.push({
        nodeId,
        name: node.name,
        category: node.category,
        icon: node.icon,
        probability: pred.probability,
        depth: pred.depth,
        cascadePath: pred.path,
        timeToImpactHours: pred.timeToImpact,
        isTrigger: triggerIds.includes(nodeId),
        riskLevel: pred.probability > 0.7 ? 'critical' : pred.probability > 0.4 ? 'high' : pred.probability > 0.2 ? 'medium' : 'low',
        populationAffected: node.population_affected,
        revenuePerHour: node.revenue_per_hour || 0,
        repairTimeHours: node.repairTimeHours,
        hasBackup: !!node.hasBackupPower
      });
    }

    results.sort((a, b) => b.probability - a.probability);

    const highRiskResults = results.filter(r => r.probability > 0.3);
    const deduplicatedPop = this.calculateDeduplicatedPopulation(highRiskResults);
    const revenue = this.calculateRevenueImpact(results);
    const mitigations = this.generateMitigations(predictions, triggerIds);
    const maxRepairTime = highRiskResults.length > 0
      ? Math.max(...highRiskResults.map(r => r.repairTimeHours))
      : 0;

    return {
      predictions: results,
      mitigations,
      summary: {
        totalAffectedServices: highRiskResults.length,
        criticalServices: results.filter(r => r.riskLevel === 'critical').length,
        highRiskServices: results.filter(r => r.riskLevel === 'high').length,
        estimatedPopulationAffected: deduplicatedPop,
        estimatedRecoveryHours: maxRepairTime,
        cascadeDepth: Math.max(...results.map(r => r.depth), 0),
        triggerNodes: triggerIds,
        revenue,
        context: {
          weather: context.weather || 'clear',
          timePeriod: context.timePeriod || 'midday',
          weatherMultiplier: context.weatherMult || 1.0,
          timeMultiplier: context.timeMult || 1.0
        }
      }
    };
  }

  emptySummary(triggerIds) {
    return {
      totalAffectedServices: 0,
      criticalServices: 0,
      highRiskServices: 0,
      estimatedPopulationAffected: 0,
      estimatedRecoveryHours: 0,
      cascadeDepth: 0,
      triggerNodes: triggerIds,
      revenue: { perHour: 0, projected4h: 0, projected24h: 0 },
      context: { weather: 'clear', timePeriod: 'midday', weatherMultiplier: 1.0, timeMultiplier: 1.0 }
    };
  }

  getHistoricalStats() {
    const byTrigger = {};
    for (const incident of this.historicalFailures) {
      if (!byTrigger[incident.trigger]) {
        byTrigger[incident.trigger] = { count: 0, avgAffected: 0, avgDuration: 0, severityCounts: { critical: 0, high: 0, medium: 0 } };
      }
      const entry = byTrigger[incident.trigger];
      entry.count++;
      entry.avgAffected += incident.affected.length;
      entry.avgDuration += incident.duration;
      entry.severityCounts[incident.severity]++;
    }

    for (const key of Object.keys(byTrigger)) {
      const s = byTrigger[key];
      s.avgAffected = parseFloat((s.avgAffected / s.count).toFixed(1));
      s.avgDuration = parseFloat((s.avgDuration / s.count).toFixed(1));
      const node = this.graph.getNode(key);
      s.name = node ? node.name : key;
      s.category = node ? node.category : 'unknown';
    }

    return byTrigger;
  }

  getHistoricalTimeline() {
    const months = {};
    for (const incident of this.historicalFailures) {
      const d = new Date(incident.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!months[key]) months[key] = { month: key, total: 0, critical: 0, high: 0, medium: 0 };
      months[key].total++;
      months[key][incident.severity]++;
    }
    return Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
  }

  getHourlyHeatmap() {
    const heatmap = {};
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        heatmap[`${day}-${hour}`] = 0;
      }
    }
    for (const incident of this.historicalFailures) {
      const key = `${incident.dayOfWeek}-${incident.hour}`;
      heatmap[key] = (heatmap[key] || 0) + 1;
    }
    return heatmap;
  }

  getCategoryStats() {
    const stats = {};
    for (const incident of this.historicalFailures) {
      const node = this.graph.getNode(incident.trigger);
      const cat = node ? node.category : 'unknown';
      if (!stats[cat]) stats[cat] = { category: cat, count: 0, critical: 0, high: 0, medium: 0 };
      stats[cat].count++;
      stats[cat][incident.severity]++;
    }
    return Object.values(stats);
  }

  assessRisk() {
    const risks = [];
    for (const node of this.graph.getAllNodes()) {
      const downstream = this.graph.getDownstream(node.id);
      const uniqueCategories = new Set(downstream.map(d => {
        const n = this.graph.getNode(d.target);
        return n ? n.category : null;
      }).filter(Boolean));

      const totalDownstreamPop = downstream.reduce((sum, d) => {
        const n = this.graph.getNode(d.target);
        return sum + (n ? n.population_affected : 0);
      }, 0);

      const totalDownstreamRevenue = downstream.reduce((sum, d) => {
        const n = this.graph.getNode(d.target);
        return sum + (n ? (n.revenue_per_hour || 0) : 0);
      }, 0);

      risks.push({
        nodeId: node.id,
        name: node.name,
        category: node.category,
        icon: node.icon,
        downstreamCount: downstream.length,
        crossCategoryImpact: uniqueCategories.size,
        riskScore: parseFloat((downstream.length * 0.3 + uniqueCategories.size * 0.7).toFixed(2)),
        categories: Array.from(uniqueCategories),
        totalDownstreamPopulation: totalDownstreamPop,
        totalDownstreamRevenue: totalDownstreamRevenue,
        hasBackup: !!node.hasBackupPower
      });
    }
    risks.sort((a, b) => b.riskScore - a.riskScore);
    return risks;
  }

  getMitigationOptions(nodeId) {
    const node = this.graph.getNode(nodeId);
    if (!node) return [];
    return node.mitigation_options || [];
  }

  getWeatherOptions() {
    return Object.entries(WEATHER_MULTIPLIERS).map(([k, v]) => ({ id: k, name: k.replaceAll('_', ' '), multiplier: v }));
  }

  getTimeOptions() {
    return Object.entries(TIME_MULTIPLIERS).map(([k, v]) => ({ id: k, name: k.replaceAll('_', ' '), multiplier: v }));
  }
}

module.exports = CascadePredictor;
