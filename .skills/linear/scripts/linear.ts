#!/usr/bin/env npx tsx
/**
 * Linear CLI for triage workflows
 * Usage: npx tsx linear.ts <command> [options]
 */

const LINEAR_API = "https://api.linear.app/graphql";
const API_KEY = process.env.LINEAR_API_KEY;

// Type definitions
interface GraphQLError {
  message: string;
}

interface WorkflowState {
  id: string;
  name: string;
}

interface IssueUpdateInput {
  priority?: number;
  stateId?: string;
}

if (!API_KEY) {
  console.error("Error: LINEAR_API_KEY environment variable not set");
  process.exit(1);
}

async function graphql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": API_KEY!,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(data.errors.map((e: GraphQLError) => e.message).join(", "));
  }
  return data.data;
}

async function listIssues(filters: { state?: string; assignee?: string; limit?: number }) {
  const limit = filters.limit || 50;
  
  let filterStr = "";
  const filterParts: string[] = [];
  
  if (filters.state) {
    filterParts.push(`state: { name: { eq: "${filters.state}" } }`);
  }
  if (filters.assignee) {
    filterParts.push(`assignee: { name: { containsIgnoreCase: "${filters.assignee}" } }`);
  }
  
  if (filterParts.length > 0) {
    filterStr = `filter: { ${filterParts.join(", ")} }`;
  }

  const query = `
    query {
      issues(first: ${limit}, ${filterStr}) {
        nodes {
          id
          identifier
          title
          priority
          state { name }
          assignee { name }
          createdAt
          url
        }
      }
    }
  `;
  
  const data = await graphql(query);
  return data.issues.nodes;
}

async function getIssue(idOrIdentifier: string) {
  // Try by identifier first (e.g., "ENG-123")
  const query = `
    query($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        priority
        state { name }
        assignee { name }
        labels { nodes { name } }
        createdAt
        updatedAt
        url
        comments {
          nodes {
            body
            user { name }
            createdAt
          }
        }
      }
    }
  `;
  
  try {
    const data = await graphql(query, { id: idOrIdentifier });
    return data.issue;
  } catch {
    // Try searching by identifier
    const searchQuery = `
      query($filter: IssueFilter) {
        issues(filter: $filter, first: 1) {
          nodes {
            id
            identifier
            title
            description
            priority
            state { name }
            assignee { name }
            labels { nodes { name } }
            createdAt
            updatedAt
            url
          }
        }
      }
    `;
    const data = await graphql(searchQuery, { 
      filter: { number: { eq: parseInt(idOrIdentifier.replace(/\D/g, "")) } }
    });
    return data.issues.nodes[0];
  }
}

async function updateIssue(id: string, updates: { priority?: number; state?: string }) {
  // First get the issue to find its ID
  const issue = await getIssue(id);
  if (!issue) {
    throw new Error(`Issue not found: ${id}`);
  }

  const input: IssueUpdateInput = {};
  
  if (updates.priority !== undefined) {
    input.priority = updates.priority;
  }
  
  if (updates.state) {
    // Need to find the state ID
    const statesQuery = `
      query {
        workflowStates {
          nodes {
            id
            name
          }
        }
      }
    `;
    const statesData = await graphql(statesQuery);
    const state = statesData.workflowStates.nodes.find(
      (s: WorkflowState) => s.name.toLowerCase() === updates.state!.toLowerCase()
    );
    if (!state) {
      throw new Error(`State not found: ${updates.state}`);
    }
    input.stateId = state.id;
  }

  const mutation = `
    mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        issue {
          id
          identifier
          title
          priority
          state { name }
        }
      }
    }
  `;
  
  const data = await graphql(mutation, { id: issue.id, input });
  return data.issueUpdate.issue;
}

async function addComment(id: string, body: string) {
  const issue = await getIssue(id);
  if (!issue) {
    throw new Error(`Issue not found: ${id}`);
  }

  const mutation = `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        comment {
          id
          body
          createdAt
        }
      }
    }
  `;
  
  const data = await graphql(mutation, { issueId: issue.id, body });
  return data.commentCreate.comment;
}

async function searchIssues(query: string) {
  const searchQuery = `
    query($query: String!) {
      searchIssues(query: $query, first: 20) {
        nodes {
          id
          identifier
          title
          priority
          state { name }
          assignee { name }
          url
        }
      }
    }
  `;
  
  const data = await graphql(searchQuery, { query });
  return data.searchIssues.nodes;
}

// CLI parsing
const args = process.argv.slice(2);
const command = args[0];

async function main() {
  try {
    switch (command) {
      case "list": {
        const filters: { state?: string; assignee?: string; limit?: number } = {};
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--state" && args[i + 1]) {
            filters.state = args[++i];
          } else if (args[i] === "--assignee" && args[i + 1]) {
            filters.assignee = args[++i];
          } else if (args[i] === "--limit" && args[i + 1]) {
            filters.limit = parseInt(args[++i]);
          }
        }
        const issues = await listIssues(filters);
        console.log(JSON.stringify(issues, null, 2));
        break;
      }
      
      case "get": {
        const id = args[1];
        if (!id) {
          console.error("Usage: get <issue-id>");
          process.exit(1);
        }
        const issue = await getIssue(id);
        console.log(JSON.stringify(issue, null, 2));
        break;
      }
      
      case "update": {
        const id = args[1];
        if (!id) {
          console.error("Usage: update <issue-id> [--priority N] [--state STATE]");
          process.exit(1);
        }
        const updates: { priority?: number; state?: string } = {};
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--priority" && args[i + 1]) {
            updates.priority = parseInt(args[++i]);
          } else if (args[i] === "--state" && args[i + 1]) {
            updates.state = args[++i];
          }
        }
        const issue = await updateIssue(id, updates);
        console.log(JSON.stringify(issue, null, 2));
        break;
      }
      
      case "comment": {
        const id = args[1];
        const body = args[2];
        if (!id || !body) {
          console.error("Usage: comment <issue-id> <body>");
          process.exit(1);
        }
        const comment = await addComment(id, body);
        console.log(JSON.stringify(comment, null, 2));
        break;
      }
      
      case "search": {
        const query = args.slice(1).join(" ");
        if (!query) {
          console.error("Usage: search <query>");
          process.exit(1);
        }
        const issues = await searchIssues(query);
        console.log(JSON.stringify(issues, null, 2));
        break;
      }
      
      default:
        console.log(`
Linear Triage CLI

Commands:
  list [--state STATE] [--assignee NAME] [--limit N]
  get <issue-id>
  update <issue-id> [--priority N] [--state STATE]
  comment <issue-id> <body>
  search <query>

Priority levels: 0=none, 1=urgent, 2=high, 3=medium, 4=low
        `);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
