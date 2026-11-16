class InfraGraph {
  constructor(data) {
    this.nodes = new Map();
    this.adjacency = new Map();
    this.reverseAdj = new Map();
    this.edges = [];

    for (const node of data.nodes) {
      this.nodes.set(node.id, { ...node, status: 'operational' });
      this.adjacency.set(node.id, []);
      this.reverseAdj.set(node.id, []);
    }

    for (const edge of data.edges) {
      if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) continue;
      this.edges.push(edge);
      this.adjacency.get(edge.from).push({ target: edge.to, weight: edge.weight, type: edge.type });
      this.reverseAdj.get(edge.to).push({ source: edge.from, weight: edge.weight, type: edge.type });
    }
  }

  hasNode(id) {
    return this.nodes.has(id);
  }

  getNode(id) {
    return this.nodes.get(id) || null;
  }

  getAllNodes() {
    return Array.from(this.nodes.values());
  }

  getNodeIds() {
    return Array.from(this.nodes.keys());
  }

  getDependencies(nodeId) {
    return this.adjacency.get(nodeId) || [];
  }

  getDependents(nodeId) {
    return this.reverseAdj.get(nodeId) || [];
  }

  getDownstream(nodeId, visited = new Set()) {
    visited.add(nodeId);
    const downstream = [];
    for (const dep of this.getDependencies(nodeId)) {
      if (!visited.has(dep.target)) {
        downstream.push(dep);
        downstream.push(...this.getDownstream(dep.target, visited));
      }
    }
    return downstream;
  }

  getUpstream(nodeId, visited = new Set()) {
    visited.add(nodeId);
    const upstream = [];
    for (const dep of this.getDependents(nodeId)) {
      if (!visited.has(dep.source)) {
        upstream.push(dep);
        upstream.push(...this.getUpstream(dep.source, visited));
      }
    }
    return upstream;
  }

  hasCycle() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of this.nodes.keys()) color.set(id, WHITE);

    const dfs = (id) => {
      color.set(id, GRAY);
      for (const dep of this.getDependencies(id)) {
        if (color.get(dep.target) === GRAY) return true;
        if (color.get(dep.target) === WHITE && dfs(dep.target)) return true;
      }
      color.set(id, BLACK);
      return false;
    };

    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE && dfs(id)) return true;
    }
    return false;
  }

  topologicalSort() {
    const visited = new Set();
    const order = [];
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dep of this.getDependencies(id)) {
        visit(dep.target);
      }
      order.unshift(id);
    };
    for (const id of this.nodes.keys()) visit(id);
    return order;
  }

  getGraphData() {
    return {
      nodes: this.getAllNodes(),
      edges: this.edges
    };
  }
}

module.exports = InfraGraph;
