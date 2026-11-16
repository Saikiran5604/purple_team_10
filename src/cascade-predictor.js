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

class CascadePredictor {
  constructor(graph, infraData) {
    this.graph = graph;
    this.infraData = infraData;
    this.rng = seededRandom(123);
    this.historicalFailures = this.generateHistoricalData();
    this.conditionalProbabilities = this.trainModel();

    this.populationZones = {
      north_residential: { population: 120000, services: ['power_substation_a', 'mobile_tower_cluster_a', 'traffic_signals_north'] },
      north_services: { population: 58000, services: ['hospital_north', 'traffic_control_center'] },
      south_residential: { population: 140000, services: ['power_substation_b', 'mobile_tower_cluster_b', 'traffic_signals_south'] },
      south_services: { population: 76000, services: ['hospital_south'] },
      central_infra: { population: 92000, services: ['telecom_data_center', 'water_pump_station'] },
      citywide_grid: { population: 485000, services: ['power_grid', 'emergency_services'] },
      water_supply: { population: 380000, services: ['water_treatment', 'water_reservoir'] }
    };
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
    if (validIds.length === 0) return { predictions: [], summary: this.emptySummary(failedNodeIds) };

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

          if (!visited.has(dep.target) && finalProb > 0.05) {
            visited.add(dep.target);
            queue.push({ id: dep.target, depth: depth + 1 });
          }
        }
      }
    }

    return this.formatPredictions(predictions, validIds, { weather, timePeriod, weatherMult, timeMult });
  }

  calculateDeduplicatedPopulation(affectedResults) {
    const hitZones = new Set();
    for (const r of affectedResults) {
      for (const [zoneName, zone] of Object.entries(this.populationZones)) {
        if (zone.services.includes(r.nodeId)) {
          hitZones.add(zoneName);
        }
      }
    }

    let total = 0;
    if (hitZones.has('citywide_grid')) {
      return this.populationZones.citywide_grid.population;
    }

    const northRes = hitZones.has('north_residential');
    const southRes = hitZones.has('south_residential');

    if (northRes) total += this.populationZones.north_residential.population;
    if (southRes) total += this.populationZones.south_residential.population;
    if (hitZones.has('north_services') && !northRes) total += this.populationZones.north_services.population;
    if (hitZones.has('south_services') && !southRes) total += this.populationZones.south_services.population;
    if (hitZones.has('central_infra')) total += this.populationZones.central_infra.population;
    if (hitZones.has('water_supply')) {
      const waterPop = this.populationZones.water_supply.population;
      total = Math.max(total, Math.min(total + waterPop * 0.3, waterPop));
    }

    return total;
  }

  calculateRevenueImpact(predictions) {
    let totalPerHour = 0;
    const breakdown = [];

    for (const p of predictions) {
      const node = this.graph.getNode(p.nodeId);
      if (!node || !node.economicImpactPerHour) continue;

      const impact = node.economicImpactPerHour * p.probability;
      totalPerHour += impact;

      breakdown.push({
        nodeId: p.nodeId,
        name: p.name,
        hourlyLoss: Math.round(impact),
        totalLoss: Math.round(impact * p.repairTimeHours),
        probability: p.probability
      });
    }

    breakdown.sort((a, b) => b.hourlyLoss - a.hourlyLoss);

    return {
      totalPerHour: Math.round(totalPerHour),
      totalProjected: Math.round(breakdown.reduce((s, b) => s + b.totalLoss, 0)),
      breakdown: breakdown.slice(0, 8)
    };
  }

  getMitigations(failedNodeIds, predictions) {
    const mitigations = this.infraData.mitigations || {};
    const result = [];

    const triggerSet = new Set(failedNodeIds);
    const criticalPreds = predictions.filter(p => p.probability > 0.3 && !p.isTrigger);

    for (const nodeId of failedNodeIds) {
      const nodeMits = mitigations[nodeId];
      if (!nodeMits) continue;
      const node = this.graph.getNode(nodeId);

      for (const m of nodeMits) {
        const downstream = this.graph.getDependencies(nodeId);
        const protectedCount = downstream.length;
        const priority = m.reduction * protectedCount;

        result.push({
          nodeId,
          nodeName: node ? node.name : nodeId,
          nodeIcon: node ? node.icon : '',
          action: m.action,
          cascadeReduction: m.reduction,
          cost: m.cost,
          deployTime: m.timeMinutes,
          protectedServices: protectedCount,
          priority: parseFloat(priority.toFixed(2)),
          type: 'trigger_mitigation'
        });
      }
    }

    for (const p of criticalPreds.slice(0, 5)) {
      const nodeMits = mitigations[p.nodeId];
      if (!nodeMits) continue;

      const best = nodeMits.reduce((a, b) => a.reduction > b.reduction ? a : b);
      const node = this.graph.getNode(p.nodeId);

      result.push({
        nodeId: p.nodeId,
        nodeName: node ? node.name : p.nodeId,
        nodeIcon: node ? node.icon : '',
        action: best.action,
        cascadeReduction: best.reduction,
        cost: best.cost,
        deployTime: best.timeMinutes,
        protectedServices: 0,
        priority: parseFloat((best.reduction * p.probability * 2).toFixed(2)),
        type: 'preventive'
      });
    }

    result.sort((a, b) => b.priority - a.priority);
    return result;
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
        repairTimeHours: node.repairTimeHours,
        economicImpactPerHour: node.economicImpactPerHour || 0,
        hasBackup: !!node.hasBackupPower
      });
    }

    results.sort((a, b) => b.probability - a.probability);

    const highRiskResults = results.filter(r => r.probability > 0.3);
    const deduplicatedPop = this.calculateDeduplicatedPopulation(highRiskResults);
    const maxRepairTime = highRiskResults.length > 0
      ? Math.max(...highRiskResults.map(r => r.repairTimeHours))
      : 0;

    const revenue = this.calculateRevenueImpact(results);
    const mitigations = this.getMitigations(triggerIds, results);

    return {
      predictions: results,
      revenue,
      mitigations: mitigations.slice(0, 10),
      summary: {
        totalAffectedServices: highRiskResults.length,
        criticalServices: results.filter(r => r.riskLevel === 'critical').length,
        highRiskServices: results.filter(r => r.riskLevel === 'high').length,
        estimatedPopulationAffected: deduplicatedPop,
        estimatedRecoveryHours: maxRepairTime,
        cascadeDepth: Math.max(...results.map(r => r.depth), 0),
        revenueAtRiskPerHour: revenue.totalPerHour,
        triggerNodes: triggerIds,
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
      revenueAtRiskPerHour: 0,
      triggerNodes: triggerIds,
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

      const totalRevenue = downstream.reduce((sum, d) => {
        const n = this.graph.getNode(d.target);
        return sum + (n ? (n.economicImpactPerHour || 0) : 0);
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
        totalDownstreamRevenue: totalRevenue,
        hasBackup: !!node.hasBackupPower
      });
    }
    risks.sort((a, b) => b.riskScore - a.riskScore);
    return risks;
  }

  getWeatherOptions() {
    return Object.entries(WEATHER_MULTIPLIERS).map(([k, v]) => ({ id: k, name: k.replaceAll('_', ' '), multiplier: v }));
  }

  getTimeOptions() {
    return Object.entries(TIME_MULTIPLIERS).map(([k, v]) => ({ id: k, name: k.replaceAll('_', ' '), multiplier: v }));
  }
}

module.exports = CascadePredictor;
