"""Optional: register this container image as an Azure Foundry hosted agent.

NOT required for local WSL Docker (use docker-compose). Use this only to deploy
the same image to Azure AI Foundry as a hosted agent speaking the RESPONSES
protocol on port 8088.

Prereqs (see the hosted-agents-v2-py skill / Foundry docs):
  1. Push the image to ACR:
       az acr build --registry <acr> --image podcast-football-agent:<tag> \
           --platform linux/amd64 --file Dockerfile .
  2. Grant the project's managed identity AcrPull on the ACR.
  3. pip install "azure-ai-projects>=2.0.0b3" azure-identity
  4. Set env: AZURE_AI_PROJECT_ENDPOINT and AGENT_IMAGE.

Run:
    python agent/deploy/create_version.py
"""

from __future__ import annotations

import os

from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import (
    AgentProtocol,
    ImageBasedHostedAgentDefinition,
    ProtocolVersionRecord,
)
from azure.identity import DefaultAzureCredential


def main() -> None:
    endpoint = os.environ["AZURE_AI_PROJECT_ENDPOINT"]
    image = os.environ["AGENT_IMAGE"]  # e.g. myacr.azurecr.io/podcast-football-agent:2026xxxx
    agent_name = os.environ.get("AGENT_NAME", "football-video-agent")

    # Environment passed into the running container. The GX10 LAN endpoints are
    # usually NOT reachable from the Foundry hosting environment, so prefer Azure
    # OpenAI for the brain + WRITE when deploying to Foundry.
    container_env = {
        k: v
        for k, v in {
            "AGENT_MODEL_BASE_URL": os.environ.get("AGENT_MODEL_BASE_URL", ""),
            "AGENT_MODEL_NAME": os.environ.get("AGENT_MODEL_NAME", ""),
            "AZURE_OPENAI_ENDPOINT": os.environ.get("AZURE_OPENAI_ENDPOINT", ""),
            "AZURE_OPENAI_DEPLOYMENT": os.environ.get("AZURE_OPENAI_DEPLOYMENT", ""),
            "HARNESS_TTS_PROVIDER": os.environ.get("HARNESS_TTS_PROVIDER", "azure"),
            "OTEL_SDK_DISABLED": "true",
        }.items()
        if v
    }

    client = AIProjectClient(endpoint=endpoint, credential=DefaultAzureCredential())
    agent = client.agents.create_version(
        agent_name=agent_name,
        definition=ImageBasedHostedAgentDefinition(
            container_protocol_versions=[
                ProtocolVersionRecord(protocol=AgentProtocol.RESPONSES, version="v1")
            ],
            image=image,
            cpu=os.environ.get("AGENT_CPU", "2"),
            memory=os.environ.get("AGENT_MEMORY", "4Gi"),
            environment_variables=container_env,
        ),
    )
    print(f"Created hosted agent: {agent.name} (version: {agent.version}, state: {agent.state})")


if __name__ == "__main__":
    main()
