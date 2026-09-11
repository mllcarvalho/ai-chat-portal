#!/usr/bin/env bash
# Sobe (ou atualiza) o portal hospedado numa conta AWS de teste, do zero:
#   builda web + relay, publica a imagem no ECR e faz o deploy da stack
#   (ECS Fargate + ALB + CloudFront) na VPC default.
#
#   AWS_REGION=us-east-1 relay/aws/deploy.sh
#
# Derrubar tudo: aws cloudformation delete-stack --stack-name portal-relay
# (e, se quiser, apagar o repositorio ECR "portal-relay").
set -euo pipefail
cd "$(dirname "$0")/../.."

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
STACK="${STACK_NAME:-portal-relay}"
REPO="${ECR_REPO:-portal-relay}"
export AWS_DEFAULT_REGION="$REGION"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
TAG="$(git rev-parse --short HEAD)-$(date +%s)"
IMAGE="$REGISTRY/$REPO:$TAG"

echo "==> build da UI e do relay"
npm run build -w @aiportal/web
npm run build -w @aiportal/relay

echo "==> imagem $IMAGE"
aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
# Fargate x86 (a task declara X86_64): num Mac ARM o --platform e obrigatorio
docker build --platform linux/amd64 -f relay/Dockerfile -t "$IMAGE" .
docker push "$IMAGE" >/dev/null

echo "==> VPC default"
VPC="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
SUBNETS="$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text | tr '\t' ',')"
echo "    $VPC  subnets: $SUBNETS"

echo "==> stack $STACK (o CloudFront leva uns 5 minutos)"
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file relay/aws/stack.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "VpcId=$VPC" "SubnetIds=$SUBNETS" "ImageUri=$IMAGE"

aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
