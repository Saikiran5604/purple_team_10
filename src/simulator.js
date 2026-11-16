const { seededRandom } = require('./utils');

class InfraSimulator {
  constructor(graph) {
    this.graph = graph;
    this.status = new Map();
    this.eventLog = [];
    this.maxLogSize = 500;
    this.tick = 0;
    this.rng = seededRandom(42);

    for (const node of graph.getAllNodes()) {
      this.status.set(node.id, {
        operational: true,
        health: 85 + this.rng() * 15,
        load: 40 + this.rng() * 40,
        lastUpdated: Date.now()
      });
    }
  }

  getStatus() {
    const result = {};
    for (const [id, s] of this.status) {
      const node = this.graph.getNode(id);
      if (!node) continue;
      result[id] = {
        ...s,
        name: node.name,
        category: node.category,
        icon: node.icon
      };
    }
    return result;
  }

  simulateTick() {
    this.tick++;

    for (const [id, s] of this.status) {
      if (s.operational) {
        s.load = Math.max(10, Math.min(95, s.load + (this.rng() - 0.5) * 8));
        let h = s.health + (this.rng() - 0.48) * 3;

        if (h < 40) h -= this.rng() * 5;
        if (s.load > 85) h -= this.rng() * 2;

        s.health = Math.max(20, Math.min(100, h));
        s.lastUpdated = Date.now();
      }
    }
  }

  triggerFailure(nodeId) {
    if (!this.graph.hasNode(nodeId)) {
      return { error: `Unknown node: ${nodeId}` };
    }

    const s = this.status.get(nodeId);
    if (!s) return { error: `No status for node: ${nodeId}` };

    if (!s.operational) {
      return {
        error: 'already_failed',
        message: `${this.graph.getNode(nodeId).name} is already down`,
        trigger: { nodeId, name: this.graph.getNode(nodeId).name, type: 'already_failed' },
        cascaded: []
      };
    }

    s.operational = false;
    s.health = 0;
    s.load = 0;
    s.lastUpdated = Date.now();

    const event = {
      timestamp: Date.now(),
      tick: this.tick,
      type: 'failure',
      nodeId,
      name: this.graph.getNode(nodeId).name
    };
    this.eventLog.push(event);

    const visited = new Set([nodeId]);
    const cascaded = this.propagateFailure(nodeId, visited);
    this.trimLog();
    return { trigger: event, cascaded };
  }

  propagateFailure(nodeId, visited) {
    const affected = [];
    const downstream = this.graph.getDependencies(nodeId);

    for (const dep of downstream) {
      if (visited.has(dep.target)) continue;
      visited.add(dep.target);

      const s = this.status.get(dep.target);
      if (!s || !s.operational) continue;

      const node = this.graph.getNode(dep.target);
      const hasBackup = node && node.hasBackupPower;
      const failChance = hasBackup ? dep.weight * 0.3 : dep.weight * 0.8;

      if (this.rng() < failChance) {
        s.operational = false;
        s.health = this.rng() * 20;
        s.load = this.rng() * 10;
        s.lastUpdated = Date.now();

        const event = {
          timestamp: Date.now(),
          tick: this.tick,
          type: 'cascade_failure',
          nodeId: dep.target,
          name: node ? node.name : dep.target,
          causedBy: nodeId,
          edgeType: dep.type
        };
        this.eventLog.push(event);
        affected.push(event);

        affected.push(...this.propagateFailure(dep.target, visited));
      } else {
        s.health = Math.max(20, s.health - dep.weight * 30);
        s.load = Math.min(95, s.load + dep.weight * 20);
      }
    }

    return affected;
  }

  applyMitigation(nodeId, effectiveness) {
    if (!this.graph.hasNode(nodeId)) {
      return { error: `Unknown node: ${nodeId}` };
    }

    const s = this.status.get(nodeId);
    if (!s) return { error: `No status for node: ${nodeId}` };

    s.operational = true;
    s.health = effectiveness * 85;
    s.load = (1 - effectiveness) * 60;
    s.lastUpdated = Date.now();

    const node = this.graph.getNode(nodeId);
    const event = {
      timestamp: Date.now(),
      tick: this.tick,
      type: 'mitigation_applied',
      nodeId,
      name: node ? node.name : nodeId,
      effectiveness
    };
    this.eventLog.push(event);
    this.trimLog();

    return {
      event,
      status: {
        operational: s.operational,
        health: s.health,
        load: s.load,
        lastUpdated: s.lastUpdated
      }
    };
  }

  restoreNode(nodeId) {
    if (!this.graph.hasNode(nodeId)) {
      return { error: `Unknown node: ${nodeId}` };
    }
    const s = this.status.get(nodeId);
    if (!s) return { error: `No status for node: ${nodeId}` };
    if (s.operational) return { message: `${this.graph.getNode(nodeId).name} is already operational` };

    s.operational = true;
    s.health = 85 + this.rng() * 15;
    s.load = 40 + this.rng() * 40;
    s.lastUpdated = Date.now();

    const event = {
      timestamp: Date.now(),
      tick: this.tick,
      type: 'restore',
      nodeId,
      name: this.graph.getNode(nodeId).name
    };
    this.eventLog.push(event);
    this.trimLog();
    return { message: `${this.graph.getNode(nodeId).name} restored`, event };
  }

  restoreAll() {
    for (const [id, s] of this.status) {
      s.operational = true;
      s.health = 85 + this.rng() * 15;
      s.load = 40 + this.rng() * 40;
      s.lastUpdated = Date.now();
    }
    this.eventLog.push({
      timestamp: Date.now(),
      tick: this.tick,
      type: 'restore_all',
      message: 'All services restored'
    });
    this.trimLog();
    return { message: 'All services restored' };
  }

  trimLog() {
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }
  }

  getEventLog(limit = 50) {
    return this.eventLog.slice(-limit).reverse();
  }

  getFailedNodes() {
    const failed = [];
    for (const [id, s] of this.status) {
      if (!s.operational) {
        const node = this.graph.getNode(id);
        failed.push({ nodeId: id, name: node ? node.name : id, category: node ? node.category : 'unknown' });
      }
    }
    return failed;
  }
}

module.exports = InfraSimulator;
