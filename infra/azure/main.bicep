targetScope = 'subscription'

@description('The disposable preview resource group name. Supply this only from the private launch parameter source.')
param resourceGroupName string

@description('Azure region for every preview resource.')
@allowed([
  'centralus'
])
param location string

@description('Required resource-group tags, including the approved owner and expiry metadata.')
param resourceGroupTags object

@description('Private parameter source for all preview resource names, image digest, and alert recipients.')
param deploymentSettings object

@secure()
@description('Provisioning-only PostgreSQL administrator password. Never commit or pass it on a command line.')
param postgresAdministratorPassword string

@secure()
@description('Private application secrets used only during the workload phase. Never commit this object or pass it on a command line.')
param applicationSecrets object = {}

@description('False creates only the resource group and foundation. True creates digest-gated API and expiry workloads.')
param deployWorkloads bool = false

resource previewResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: resourceGroupTags
}

module previewRuntime './runtime.bicep' = {
  name: 'temporary-preview-runtime'
  scope: resourceGroup(resourceGroupName)
  dependsOn: [
    previewResourceGroup
  ]
  params: {
    location: location
    settings: deploymentSettings
    postgresAdministratorPassword: postgresAdministratorPassword
    databaseUrl: applicationSecrets.?databaseUrl ?? ''
    workspaceSigningKey: applicationSecrets.?workspaceSigningKey ?? ''
    originSharedSecret: applicationSecrets.?originSharedSecret ?? ''
    geminiApiKey: applicationSecrets.?geminiApiKey ?? ''
    fishApiKey: applicationSecrets.?fishApiKey ?? ''
    deployWorkloads: deployWorkloads
  }
}
